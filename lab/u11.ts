/**
 * Plan U11's hardware check. Tick the preconditions and Start: the page runs U11_STEPS, stopping at each user step
 * until Yes or No. While a keylog step shows, every keydown and keyup `code` the page sees is logged with the answer.
 * Download the transcript and run tools/u11-verdict.ts, which writes the capture for the commit that moves the four
 * U11 rows to "confirmed". `?fake` runs on the fake board: Yes on the power-cycle step power-cycles it, and a button
 * presses its Caps Lock key.
 */
import { FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, FakeLocks } from "../testing/fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "../testing/transcript";
import { startWebHidLab } from "../web/webhid-port";
import { U1_EXPECTED } from "./u1-job";
import { preconditionsLocked, tickedBoxes } from "./u1-state";
import { type Attestation, U11_PRECONDITIONS, U11_ROWS, type UserStep, attestEntry, framesOutsideU11, runU11, u11Clearance, u11Preconditions } from "./u11-run";

const fakeMode = new URLSearchParams(location.search).get("fake");
const started = new Date();
const now = () => performance.now();
const entries: TranscriptEntry[] = [];
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
	return found;
}

const ui = {
	about: byId("about", HTMLParagraphElement),
	preconditions: byId("preconditions", HTMLFieldSetElement),
	start: byId("start", HTMLButtonElement),
	pick: byId("pick", HTMLButtonElement),
	download: byId("download", HTMLButtonElement),
	step: byId("step", HTMLElement),
	stepLabel: byId("step-label", HTMLParagraphElement),
	keylog: byId("keylog", HTMLOutputElement),
	simulate: byId("simulate", HTMLButtonElement),
	stepQuestion: byId("step-question", HTMLParagraphElement),
	yes: byId("yes", HTMLButtonElement),
	no: byId("no", HTMLButtonElement),
	summary: byId("summary", HTMLParagraphElement),
	outcomes: byId("outcomes", HTMLOListElement),
	log: byId("log", HTMLPreElement),
};

const log = (line: string) => {
	ui.log.textContent += `${(now() / 1000).toFixed(3)}s ${line}\n`;
};

const fakeBoard =
	fakeMode === null ? null : new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 } });
const CAPS_LOCK_CELL = 4;
const CODE_OF_USAGE: Readonly<Record<number, string>> = { 0x39: "CapsLock", 0xe0: "ControlLeft" };

function hardware(): { readonly hid: HID; readonly locks: LockManager } {
	if (fakeBoard === null) return { hid: navigator.hid, locks: navigator.locks };
	return { hid: new FakeHid(fakeBoard, { rowAppearsInOpenChooser: ["app"] }), locks: new FakeLocks() };
}

const transcript = (): Transcript => ({
	format: "tab60kit-transcript/1",
	recordedAt: started.toISOString(),
	environment: {
		tool: TAB60KIT_COMMIT,
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		page: location.href,
		fake: fakeMode === null ? "no" : fakeMode || "plain",
		...u11Preconditions.preconditionEnvironment(entries),
	},
	entries: [...entries],
});

let running = false;
let ran = false;
const boxes = U11_PRECONDITIONS.map(({ key, label }) => {
	const box = document.createElement("input");
	box.type = "checkbox";
	box.addEventListener("change", () => {
		const change = u11Preconditions.preconditionChange(entries, key, box.checked, now());
		if (change !== null) entries.push(change);
		render();
	});
	const row = document.createElement("label");
	row.append(box, ` ${label}`);
	const line = document.createElement("div");
	line.append(row);
	ui.preconditions.append(line);
	return { key, box };
});

/** One run per page load: the verdict expects the plan once. */
function render(): void {
	const on = tickedBoxes(entries);
	const locked = preconditionsLocked(entries);
	for (const { key, box } of boxes) {
		box.checked = on.has(key);
		box.disabled = locked;
	}
	ui.start.disabled = running || ran || locked || !u11Preconditions.allTicked(entries);
	ui.download.disabled = entries.length === 0;
}

/** Shows `step`, logs key codes while it is a keylog step, and resolves on Yes or No after recording the attestation. */
function attend(step: UserStep): Promise<Attestation> {
	const keys: string[] = [];
	const onKey = (event: KeyboardEvent) => {
		keys.push(event.code);
		ui.keylog.value = keys.join(" ");
	};
	const press = () => {
		const sent = fakeBoard?.baseLayerPress(CAPS_LOCK_CELL);
		keys.push(sent === null || sent === undefined ? "none" : (CODE_OF_USAGE[sent] ?? `usage-0x${sent.toString(16)}`));
		ui.keylog.value = keys.join(" ");
	};
	if (step.keylog !== null) {
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKey);
	}
	ui.stepLabel.textContent = step.label;
	ui.stepQuestion.textContent = step.question;
	ui.keylog.value = step.keylog === null ? "(not logged in this step)" : "";
	ui.simulate.hidden = fakeBoard === null || step.keylog === null;
	ui.simulate.addEventListener("click", press);
	ui.step.hidden = false;
	ui.yes.focus();
	return new Promise((resolve) => {
		const answer = (yes: boolean) => () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onKey);
			ui.simulate.removeEventListener("click", press);
			ui.yes.onclick = null;
			ui.no.onclick = null;
			ui.step.hidden = true;
			if (yes && step.id === "power-cycle") fakeBoard?.powerCycle();
			const attestation = { answer: yes, keys };
			entries.push(attestEntry(step, attestation, now()));
			render();
			resolve(attestation);
		};
		ui.yes.onclick = answer(true);
		ui.no.onclick = answer(false);
	});
}

try {
	if (fakeMode === null && !("hid" in navigator)) throw new Error("Use Chrome or Edge: this browser has no WebHID.");
	const clearance = u11Clearance();
	const { hid, locks } = hardware();
	const { port, chooser } = startWebHidLab(hid, locks, {
		wrap: (link) => recording(link, (entry) => entries.push(entry), now),
		onEvent: (event) => entries.push({ t: now(), ...event }),
	});
	ui.about.textContent = `Lab clearance: ${U11_ROWS.join(", ")}. Tool ${TAB60KIT_COMMIT}. ${fakeMode === null ? "Real WebHID." : "Fake board."}`;
	chooser.subscribe(() => {
		ui.pick.hidden = chooser.needsClick === null;
	});
	ui.pick.addEventListener("click", () => chooser.pick());
	ui.start.addEventListener("click", () => {
		running = true;
		ran = true;
		render();
		ui.summary.textContent = "Running...";
		ui.outcomes.replaceChildren();
		const show = (line: string) => {
			const li = document.createElement("li");
			li.textContent = line;
			ui.outcomes.append(li);
		};
		void port
			.exclusive(() =>
				runU11(port, clearance, attend, ({ pass, label, detail }) => show(`${pass ? "PASS" : "FAIL"} ${label}: ${detail}`), new AbortController().signal),
			)
			.then((outcomes) => {
				const failed = outcomes.filter(({ pass }) => !pass).length;
				const stray = framesOutsideU11(entries);
				for (const hex of stray) show(`frame outside the U11 rows: ${hex}`);
				ui.summary.textContent = `${failed === 0 && stray.length === 0 ? "PASS" : "FAIL"}: ${outcomes.length} steps, ${failed} failed, ${stray.length} frames outside the U11 rows. The verdict decides.`;
				log(`ran ${outcomes.length} steps`);
			})
			.catch((error: unknown) => {
				ui.summary.textContent = `FAIL: ${describe(error)}. Nothing was saved to flash: a power cycle with the batteries out restores the saved keymap.`;
				log(`run failed: ${describe(error)}`);
			})
			.finally(() => {
				running = false;
				ui.step.hidden = true;
				render();
			});
	});
	ui.download.addEventListener("click", () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u11-${started.toISOString().replace(/[:.]/g, "-")}${fakeMode === null ? "" : "-fake"}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});
	render();
} catch (error) {
	ui.about.textContent = `This page cannot start. ${describe(error)}`;
	ui.preconditions.disabled = true;
	ui.start.disabled = true;
}
