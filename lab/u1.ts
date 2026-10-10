import { TAB60 } from "../core/device";
import { type DeviceWant, PickCancelled } from "../core/port";
import type { Transcript, TranscriptEntry } from "../testing/transcript";
import { type PortEvent, startWebHidLab } from "../web/webhid-port";
import { evaluateU1 } from "./u1-checks";
import { FAKE_MODES, type FakeMode, fakeHardware, isFakeMode } from "./u1-fake";
import { u1Wrap } from "./u1-frames";
import { type U1Context, U1_EXPECTED, U1_PROBES, U1_ROWS, u1Clearance, u1Run } from "./u1-job";
import {
	AWAY_RECOVERY,
	PRECONDITIONS,
	PRECONDITION_MET,
	type Phase,
	type Run,
	type RunOutcome,
	atLoad,
	awayFromHome,
	outcomeOfError,
	phaseAfterRun,
	pickHint,
	pickLabel,
} from "./u1-state";

function fakeModeOf(search: string): string | null {
	const value = new URLSearchParams(search).get("fake");
	if (value === null) return null;
	return value === "" ? "plain" : value;
}
const fakeMode = fakeModeOf(location.search);

function element<T extends HTMLElement>(id: string, type: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
	return found;
}

const ui = {
	clearance: element("clearance", HTMLParagraphElement),
	preconditions: element("preconditions", HTMLFieldSetElement),
	connect: element("connect", HTMLButtonElement),
	deepCheck: element("deepcheck", HTMLButtonElement),
	pick: element("pick", HTMLButtonElement),
	pickHint: element("pickhint", HTMLParagraphElement),
	cancel: element("cancel", HTMLButtonElement),
	restart: element("restart", HTMLButtonElement),
	tryAgain: element("tryagain", HTMLButtonElement),
	download: element("download", HTMLButtonElement),
	recovery: element("recovery", HTMLPreElement),
	typing: element("typing", HTMLInputElement),
	frames: element("frames", HTMLParagraphElement),
	checks: element("checks", HTMLOListElement),
	findings: element("findings", HTMLUListElement),
	log: element("log", HTMLPreElement),
};

const started = new Date();
const now = () => performance.now();
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
const pid = (productId: number) => `0x${productId.toString(16)}`;

function log(line: string): void {
	ui.log.textContent += `${(now() / 1000).toFixed(3)}s ${line}\n`;
}

function describeEvent(event: PortEvent): string {
	switch (event.kind) {
		case "pick":
			return `pick (${event.path}, ${event.reason}): ${event.productId === null ? "no device" : pid(event.productId)} after ${Math.round(event.waitMs)} ms`;
		case "opened":
			return `opened ${event.productName} ${pid(event.productId)} for ${event.reason}, ${event.collections.length} collection(s)`;
		case "open-attempt":
			return `open attempt ${event.attempt} on ${pid(event.productId)}: ${event.error ?? "ok"}`;
		case "close-timeout":
			return `close of ${pid(event.productId)} did not settle in time, counted as closed`;
		default: {
			const exhaustive: never = event;
			return exhaustive;
		}
	}
}

const fakeLink = (mode: FakeMode) => (mode === "plain" ? "?fake" : `?fake=${mode}`);

async function start(): Promise<void> {
	if (fakeMode !== null && !isFakeMode(fakeMode)) {
		ui.clearance.textContent = `Unknown ?fake value "${fakeMode}". Use ${FAKE_MODES.map(fakeLink).join(", ")}.`;
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

	const fake = fakeMode === null ? null : fakeHardware(fakeMode, { probes: U1_PROBES.probes });
	const hid = fake?.hid ?? navigator.hid;
	const load = await atLoad(hid, now);

	const preconditions = PRECONDITIONS.map(({ key, label }) => {
		const box = document.createElement("input");
		box.type = "checkbox";
		box.addEventListener("change", () => render());
		const row = document.createElement("label");
		row.append(box, ` ${label}`);
		const line = document.createElement("div");
		line.append(row);
		ui.preconditions.append(line);
		return { key, box };
	});
	const preconditionsMet = () => preconditions.every(({ box }) => box.checked);

	const entries: TranscriptEntry[] = [...load.entries];
	for (const { productId } of load.entries) log(`granted at load: ${pid(productId)}`);
	let lastOpened: number | null = null;
	const { port, chooser } = startWebHidLab(hid, fake?.locks ?? navigator.locks, {
		wrap: u1Wrap((entry) => entries.push(entry), now),
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
			...Object.fromEntries(preconditions.map(({ key, box }) => [key, box.checked ? PRECONDITION_MET : "no"])),
		},
		entries: [...entries],
	});
	const recordVisibility = () => entries.push({ t: now(), kind: "visibility", state: document.visibilityState === "hidden" ? "hidden" : "visible" });
	recordVisibility();
	document.addEventListener("visibilitychange", recordVisibility);
	const ran = () => entries.some((entry) => entry.kind !== "visibility" && entry.kind !== "typing" && entry.kind !== "granted");

	let phase: Phase = load.phase;
	let controller: AbortController | null = null;
	let parked: DeviceWant | null = null;

	const render = () => {
		const want = chooser.needsClick;
		if (want !== null && want !== parked) log(`pick parked (${want.reason}): click "${pickLabel(want)}"`);
		parked = want;
		const away = phase.kind === "away";
		const canConnect = phase.kind === "idle" || phase.kind === "connected" || phase.kind === "failed" || phase.kind === "refused" || (phase.kind === "away" && phase.holding === null);
		ui.connect.disabled = !canConnect || !preconditionsMet();
		ui.deepCheck.disabled = phase.kind !== "connected";
		ui.pick.hidden = want === null;
		ui.pick.textContent = pickLabel(want);
		const hint = pickHint(want);
		ui.pickHint.hidden = hint === null;
		ui.pickHint.textContent = hint ?? "";
		ui.cancel.hidden = phase.kind !== "running";
		ui.cancel.textContent = awayFromHome(entries) ? "Stop and send the board home" : "Cancel";
		ui.tryAgain.hidden = !away;
		ui.restart.hidden = !away;
		ui.recovery.hidden = !away;
		ui.recovery.textContent = AWAY_RECOVERY;
		ui.download.disabled = !ran();
	};

	const showVerdict = async () => {
		if (!ran()) return;
		const verdict = await evaluateU1(transcript(), { expected: U1_EXPECTED, typing: ui.typing.value.length > 0 ? "types" : "not-observed" });
		const item = (text: string) => {
			const li = document.createElement("li");
			li.textContent = text;
			return li;
		};
		ui.frames.textContent = `${verdict.frames.pass ? "PASS" : "FAIL"} ${verdict.frames.title}. ${verdict.frames.detail}`;
		ui.checks.replaceChildren(...verdict.checks.map((check) => item(`${check.pass ? "PASS" : "FAIL"} ${check.id}. ${check.title}. ${check.detail}`)));
		ui.findings.replaceChildren(...verdict.findings.map((finding) => item(`Finding: ${finding}`)));
	};

	const run = (what: Run) => {
		if (controller !== null) return;
		const from = phase;
		const own = new AbortController();
		controller = own;
		phase = { kind: "running", what };
		ui.typing.value = "";
		fake?.adjust(what);
		render();
		const ctx: U1Context = { port, clearance, signal: own.signal, log, series: U1_PROBES };
		const ticker = setInterval(render, 100);
		void (async () => {
			let outcome: RunOutcome;
			try {
				outcome = await port.exclusive(() => u1Run(what, from, ctx));
			} catch (error) {
				outcome = outcomeOfError(error);
				log(outcome.kind === "cancelled" ? `${what} cancelled${error instanceof PickCancelled ? " (the chooser closed with no device)" : ""}` : `${what} failed: ${describe(error)}`);
			}
			clearInterval(ticker);
			// A pick this run left parked must not answer the next run's click.
			own.abort(new DOMException("the run ended", "AbortError"));
			controller = null;
			phase = phaseAfterRun(entries, outcome);
			render();
			await showVerdict();
		})();
	};

	ui.connect.addEventListener("click", () => run("connect"));
	ui.deepCheck.addEventListener("click", () => run("deep-check"));
	ui.tryAgain.addEventListener("click", () => run("try-again"));
	ui.restart.addEventListener("click", () => run("restart"));
	ui.pick.addEventListener("click", () => chooser.pick());
	ui.cancel.addEventListener("click", () => controller?.abort(new DOMException("cancelled from the page", "AbortError")));
	ui.typing.addEventListener("input", () => {
		if (lastOpened === TAB60.productId.app) entries.push({ t: now(), kind: "typing", chars: ui.typing.value.length });
		void showVerdict();
	});
	addEventListener("beforeunload", (event) => {
		if (!awayFromHome(entries)) return;
		event.preventDefault();
		event.returnValue = true;
	});
	ui.download.addEventListener("click", () => {
		const blob = new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u1-${started.toISOString().replace(/[:.]/g, "-")}${fakeMode === null ? "" : `-fake-${fakeMode}`}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});

	render();
}

start().catch((error: unknown) => {
	ui.clearance.textContent = `This page cannot start. ${describe(error)}`;
});
