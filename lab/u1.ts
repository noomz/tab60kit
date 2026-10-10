import { LinkTimeout, PickCancelled } from "../core/port";
import type { AppSession, Refused } from "../core/protocol";
import { FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, FakeLocks } from "../testing/fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "../testing/transcript";
import { type PortEvent, startWebHidLab } from "../web/webhid-port";
import { evaluateU1 } from "./u1-checks";
import { type DeepCheckEnd, type U1Context, U1_EXPECTED, U1_PROBES, U1_ROWS, u1Clearance, u1Connect, u1DeepCheck, u1TryAgain } from "./u1-job";

export const NO_ANSWER_RECOVERY = [
	"No answer in update mode. The bootloader may be ignoring our frames: bytes 2..3 carry 0x0000, pok3rtool's value, and the vendor updater's value is unread.",
	"Try again reuses the device the chooser already granted.",
	"If it still answers nothing: unplug the cable, take the batteries out for 10 seconds, and put them back. A cold boot clears the SRAM magic that RESET to IAP set.",
	"Or run the vendor updater with -force on MaruStation.",
].join("\n");

type Run = "connect" | "deep-check" | "try-again" | "restart";

type Phase =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly what: Run }
	| { readonly kind: "connected"; readonly app: AppSession }
	| { readonly kind: "refused"; readonly refused: Refused }
	| { readonly kind: "no-answer" }
	| { readonly kind: "failed" };

type FakeMode = "plain" | "parked" | "cancel" | "deaf";
const FAKE_MODES: readonly string[] = ["plain", "parked", "cancel", "deaf"] satisfies readonly FakeMode[];
const isFakeMode = (value: string): value is FakeMode => FAKE_MODES.includes(value);

/** null for the real WebHID; "plain" for ?fake with no value; a string outside FakeMode stops the page. */
function fakeModeOf(search: string): FakeMode | null | string {
	const value = new URLSearchParams(search).get("fake");
	if (value === null) return null;
	if (value === "") return "plain";
	return value;
}
const fakeMode = fakeModeOf(location.search);

function element<T extends HTMLElement>(id: string, type: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
	return found;
}

const ui = {
	clearance: element("clearance", HTMLParagraphElement),
	connect: element("connect", HTMLButtonElement),
	deepCheck: element("deepcheck", HTMLButtonElement),
	pick: element("pick", HTMLButtonElement),
	cancel: element("cancel", HTMLButtonElement),
	restart: element("restart", HTMLButtonElement),
	tryAgain: element("tryagain", HTMLButtonElement),
	download: element("download", HTMLButtonElement),
	recovery: element("recovery", HTMLPreElement),
	typing: element("typing", HTMLInputElement),
	checks: element("checks", HTMLOListElement),
	findings: element("findings", HTMLUListElement),
	log: element("log", HTMLPreElement),
};

const started = new Date();
const now = () => performance.now();
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function log(line: string): void {
	ui.log.textContent += `${(now() / 1000).toFixed(3)}s ${line}\n`;
}

const pid = (productId: number) => `0x${productId.toString(16)}`;

function describeEvent(event: PortEvent): string {
	switch (event.kind) {
		case "pick":
			return `pick (${event.path}, ${event.reason}): ${event.productId === null ? "no device" : pid(event.productId)} after ${Math.round(event.waitMs)} ms`;
		case "opened":
			return `opened ${event.productName} ${pid(event.productId)}, ${event.collections.length} collection(s)`;
		case "open-attempt":
			return `open attempt ${event.attempt} on ${pid(event.productId)}: ${event.error ?? "ok"}`;
		case "close-timeout":
			return `close of ${pid(event.productId)} did not settle in time; counted as closed`;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

function hardware(mode: FakeMode | null): { readonly hid: HID; readonly locks: LockManager; readonly board: FakeTab60 | null } {
	if (mode === null) return { hid: navigator.hid, locks: navigator.locks, board: null };
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 } });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: mode === "parked" ? [] : ["app", "iap"] });
	if (mode === "cancel") hid.chooser = "cancel";
	if (mode === "deaf") board.ignoreInIap = true;
	return { hid, locks: new FakeLocks(), board };
}

function start(): void {
	if (fakeMode !== null && !isFakeMode(fakeMode)) {
		ui.clearance.textContent = `Unknown ?fake value "${fakeMode}". Use ?fake, ?fake=parked, ?fake=cancel, or ?fake=deaf.`;
		return;
	}
	if (fakeMode === null && !("hid" in navigator)) {
		ui.clearance.textContent = "Use Chrome or Edge: this browser has no WebHID.";
		return;
	}
	let clearance: ReturnType<typeof u1Clearance>;
	try {
		clearance = u1Clearance();
	} catch (error) {
		ui.clearance.textContent = `This page cannot start. ${describe(error)}`;
		return;
	}
	ui.clearance.textContent = `Lab clearance: ${U1_ROWS.join(", ")}. Tool ${TAB60KIT_COMMIT}. ${fakeMode === null ? "Real WebHID." : `Fake board (${fakeMode}).`}`;

	const { hid, locks, board } = hardware(fakeMode);
	const entries: TranscriptEntry[] = [];
	let lastOpened: number | null = null;
	const { port, chooser } = startWebHidLab(hid, locks, {
		wrap: (link) => recording(link, (entry) => entries.push(entry), now),
		onEvent: (event) => {
			entries.push({ t: now(), ...event });
			if (event.kind === "opened") lastOpened = event.productId;
			log(describeEvent(event));
		},
	});
	const transcript = (): Transcript => ({
		format: "tab60kit-transcript/1",
		recordedAt: started.toISOString(),
		environment: {
			tool: TAB60KIT_COMMIT,
			userAgent: navigator.userAgent,
			platform: navigator.platform,
			fake: fakeMode ?? "no",
			page: location.href,
		},
		entries: [...entries],
	});

	let phase: Phase = { kind: "idle" };
	let controller: AbortController | null = null;

	const render = () => {
		ui.connect.disabled = phase.kind === "running";
		ui.deepCheck.disabled = phase.kind !== "connected";
		ui.pick.hidden = chooser.needsClick === null;
		ui.cancel.hidden = phase.kind !== "running";
		ui.restart.hidden = !(phase.kind === "refused" && phase.refused.restartToApp !== null);
		ui.tryAgain.hidden = phase.kind !== "no-answer";
		ui.recovery.hidden = phase.kind !== "no-answer";
		ui.recovery.textContent = NO_ANSWER_RECOVERY;
		ui.download.disabled = entries.length === 0;
	};

	const showVerdict = async () => {
		if (entries.length === 0) return;
		const verdict = await evaluateU1(transcript(), { expected: U1_EXPECTED, typing: ui.typing.value.length > 0 ? "types" : "not-observed" });
		const item = (text: string) => {
			const li = document.createElement("li");
			li.textContent = text;
			return li;
		};
		ui.checks.replaceChildren(...verdict.checks.map((check) => item(`${check.pass ? "PASS" : "FAIL"} ${check.id}. ${check.title}. ${check.detail}`)));
		ui.findings.replaceChildren(...verdict.findings.map((finding) => item(`Finding: ${finding}`)));
	};

	const failure = (error: unknown): Phase => {
		if (error instanceof LinkTimeout && lastOpened === U1_EXPECTED.iapProductId) return { kind: "no-answer" };
		if (error instanceof PickCancelled || (error instanceof DOMException && error.name === "AbortError")) return { kind: "idle" };
		return { kind: "failed" };
	};

	const run = (what: Run, body: (ctx: U1Context) => Promise<Phase>) => {
		if (controller !== null) return;
		controller = new AbortController();
		const previous = phase;
		phase = { kind: "running", what };
		render();
		const ctx: U1Context = { port, clearance, signal: controller.signal, log, series: U1_PROBES };
		const ticker = setInterval(render, 100);
		void (async () => {
			try {
				await port.exclusive(async () => {
					if (what === "connect" && previous.kind === "connected") await previous.app.close();
					if (what === "connect" && previous.kind === "refused") await previous.refused.close();
					phase = await body(ctx);
				});
			} catch (error) {
				log(`${what} failed: ${describe(error)}`);
				phase = failure(error);
			} finally {
				clearInterval(ticker);
				// A run that failed inside enterIap may have left its update-mode open pending; the abort rejects it.
				controller?.abort(new DOMException("the run ended", "AbortError"));
				controller = null;
				render();
				await showVerdict();
			}
		})();
	};

	const finish = (end: DeepCheckEnd): Phase => {
		if (end.kind === "refused") {
			log(`update mode refused: ${end.refused.refusal.code}`);
			return { kind: "refused", refused: end.refused };
		}
		if (end.back === null) return { kind: "idle" };
		if ("refusal" in end.back) {
			log(`normal mode refused after the round trip: ${end.back.refusal.code}`);
			return { kind: "refused", refused: end.back };
		}
		return { kind: "connected", app: end.back };
	};

	ui.connect.addEventListener("click", () =>
		run("connect", async (ctx) => {
			const end = await u1Connect(ctx);
			if (end.kind === "refused") {
				log(`normal mode refused: ${end.refused.refusal.code}`);
				return { kind: "refused", refused: end.refused };
			}
			return { kind: "connected", app: end.session };
		}),
	);
	ui.deepCheck.addEventListener("click", () => {
		if (phase.kind !== "connected") return;
		const { app } = phase;
		run("deep-check", async (ctx) => finish(await u1DeepCheck(app, ctx)));
	});
	ui.tryAgain.addEventListener("click", () => {
		if (board !== null) board.ignoreInIap = false;
		run("try-again", async (ctx) => finish(await u1TryAgain(ctx)));
	});
	ui.restart.addEventListener("click", () => {
		if (phase.kind !== "refused" || phase.refused.restartToApp === null) return;
		const { refused } = phase;
		run("restart", async () => {
			await refused.restartToApp();
			log("RESET to app sent; the board should enumerate as 0x0304 and type");
			return { kind: "idle" };
		});
	});
	ui.pick.addEventListener("click", () => chooser.pick());
	ui.cancel.addEventListener("click", () => controller?.abort(new DOMException("cancelled from the page", "AbortError")));
	ui.typing.addEventListener("input", () => void showVerdict());
	ui.download.addEventListener("click", () => {
		const blob = new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u1-${started.toISOString().replace(/[:.]/g, "-")}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});

	render();
}

start();
