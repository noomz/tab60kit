/**
 * Unit U12's hardware check. Choose the OS key mode, tick the preconditions, and Start: the page runs U12_STEPS,
 * stopping at each user step until Yes or No, and logging every keydown and keyup `code` during a keylog step. At the
 * reload step it saves its progress to sessionStorage and asks for a reload; after it, Continue reads the keymap back
 * from the editor's storage (localStorage, the shipped page's code) and finishes the run. Download the transcript and
 * run tools/u12-verdict.ts. `?fake` runs on the fake board, which a reload replaces with a fresh one; Yes on the
 * battery-pull step power-cycles it, and a button presses the step's key.
 */
import { OS_KEY_MODES, type OsKeyMode, usage } from "../core/keymap";
import { FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, FakeLocks } from "../testing/fake-webhid";
import { type Transcript, type TranscriptEntry, parseTranscript, recording } from "../testing/transcript";
import { targetOf } from "../web/usages";
import { startWebHidLab } from "../web/webhid-port";
import { showParkedPick } from "./pick-wait";
import { U1_EXPECTED } from "./u1-job";
import { preconditionsLocked, tickedBoxes } from "./u1-state";
import { type Attestation, RELOAD_INDEX, U12_KEYS, U12_PRECONDITIONS, U12_ROWS, type UserStep, attestEntry, framesOutsideU12, runU12, u12Clearance, u12Preconditions } from "./u12-run";

const PROGRESS_KEY = "tab60kit-lab-u12-progress";
const fakeMode = new URLSearchParams(location.search).get("fake");
const now = () => performance.now();
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
	return found;
}

const ui = {
	about: byId("about", HTMLParagraphElement),
	preconditions: byId("preconditions", HTMLFieldSetElement),
	osKeyMode: byId("os-key-mode", HTMLSelectElement),
	start: byId("start", HTMLButtonElement),
	reload: byId("reload", HTMLButtonElement),
	resume: byId("continue", HTMLButtonElement),
	pick: byId("pick", HTMLButtonElement),
	download: byId("download", HTMLButtonElement),
	discard: byId("discard", HTMLButtonElement),
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

const isOsKeyMode = (value: string): value is OsKeyMode => Object.hasOwn(OS_KEY_MODES, value);
const chosenMode = (): OsKeyMode | null => (isOsKeyMode(ui.osKeyMode.value) ? ui.osKeyMode.value : null);

/** The run before the reload, kept for this tab only. A reload changes `performance.now()`'s origin, so times restart. */
interface Progress {
	readonly recordedAt: string;
	readonly mode: OsKeyMode;
	readonly transcript: Transcript;
}

function loadProgress(): Progress | null {
	try {
		const text = sessionStorage.getItem(PROGRESS_KEY);
		if (text === null) return null;
		const json: unknown = JSON.parse(text);
		if (typeof json !== "object" || json === null) return null;
		const { recordedAt, mode, transcript } = json as Record<string, unknown>;
		if (typeof recordedAt !== "string" || typeof mode !== "string" || !isOsKeyMode(mode)) return null;
		return { recordedAt, mode, transcript: parseTranscript(transcript) };
	} catch (error) {
		log(`saved progress unreadable: ${describe(error)}`);
		return null;
	}
}

function forgetProgress(): void {
	try {
		sessionStorage.removeItem(PROGRESS_KEY);
	} catch (error) {
		log(`could not clear saved progress: ${describe(error)}`);
	}
}

const resumed = loadProgress();
const recordedAt = resumed?.recordedAt ?? new Date().toISOString();
const entries: TranscriptEntry[] = [...(resumed?.transcript.entries ?? [])];
if (resumed !== null) ui.osKeyMode.value = resumed.mode;

const fakeBoard =
	fakeMode === null ? null : new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 } });

function hardware(): { readonly hid: HID; readonly locks: LockManager } {
	if (fakeBoard === null) return { hid: navigator.hid, locks: navigator.locks };
	return { hid: new FakeHid(fakeBoard, { rowAppearsInOpenChooser: ["app"] }), locks: new FakeLocks() };
}

const transcript = (): Transcript => {
	const mode = chosenMode();
	return {
		format: "tab60kit-transcript/1",
		recordedAt,
		environment: {
			tool: TAB60KIT_COMMIT,
			userAgent: navigator.userAgent,
			platform: navigator.platform,
			page: location.href,
			fake: fakeMode === null ? "no" : fakeMode || "plain",
			...(mode === null ? {} : { osKeyMode: mode }),
			...u12Preconditions.preconditionEnvironment(entries),
		},
		entries: [...entries],
	};
};

let running = false;
let phase: "before" | "paused" | "resumable" | "done" = resumed === null ? "before" : "resumable";
const boxes = U12_PRECONDITIONS.map(({ key, label }) => {
	const box = document.createElement("input");
	box.type = "checkbox";
	box.addEventListener("change", () => {
		const change = u12Preconditions.preconditionChange(entries, key, box.checked, now());
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

function render(): void {
	const on = tickedBoxes(entries);
	const locked = preconditionsLocked(entries);
	for (const { key, box } of boxes) {
		box.checked = on.has(key);
		box.disabled = locked;
	}
	ui.osKeyMode.disabled = locked || phase !== "before";
	ui.start.hidden = phase !== "before";
	ui.start.disabled = running || locked || chosenMode() === null || !u12Preconditions.allTicked(entries);
	ui.reload.hidden = phase !== "paused";
	ui.resume.hidden = phase !== "resumable";
	ui.resume.disabled = running;
	ui.discard.hidden = phase === "before" || running;
	ui.download.disabled = entries.length === 0;
}

const CODE_OF_USAGE = (u: number) => targetOf(usage(u))?.code ?? `usage-0x${u.toString(16)}`;

/** Shows `step`, logs key codes while it is a keylog step, and resolves on Yes or No after recording the attestation. */
function attend(step: UserStep): Promise<Attestation> {
	const keys: string[] = [];
	const key = U12_KEYS.find(({ from }) => step.id.endsWith(`-${from.toString(16).padStart(2, "0")}`));
	const onKey = (event: KeyboardEvent) => {
		event.preventDefault();
		keys.push(event.code);
		ui.keylog.value = keys.join(" ");
	};
	const press = () => {
		const sent = key === undefined ? null : fakeBoard?.baseLayerPress(key.cell);
		keys.push(sent === null || sent === undefined ? "none" : CODE_OF_USAGE(sent));
		ui.keylog.value = keys.join(" ");
	};
	if (step.keylog !== null) {
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKey);
	}
	ui.stepLabel.textContent = step.label;
	ui.stepQuestion.textContent = step.question;
	ui.keylog.value = step.keylog === null ? "(not logged in this step)" : "";
	ui.simulate.hidden = fakeBoard === null || key === undefined;
	ui.simulate.textContent = `Press ${key?.legend ?? "the key"} on the fake board`;
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
			if (yes && step.id === "battery-pull") fakeBoard?.powerCycle();
			const attestation = { answer: yes, keys };
			entries.push(attestEntry(step, attestation, now()));
			render();
			resolve(attestation);
		};
		ui.yes.onclick = answer(true);
		ui.no.onclick = answer(false);
	});
}

const show = (line: string) => {
	const li = document.createElement("li");
	li.textContent = line;
	ui.outcomes.append(li);
};

try {
	if (fakeMode === null && !("hid" in navigator)) throw new Error("Use Chrome or Edge: this browser has no WebHID.");
	const clearance = u12Clearance();
	const { hid, locks } = hardware();
	const { port, chooser } = startWebHidLab(hid, locks, {
		wrap: (link) => recording(link, (entry) => entries.push(entry), now),
		onEvent: (event) => entries.push({ t: now(), ...event }),
	});
	ui.about.textContent = `Lab clearance: ${U12_ROWS.join(", ")}. Tool ${TAB60KIT_COMMIT}. ${fakeMode === null ? "Real WebHID." : "Fake board."}${resumed === null ? "" : " Resumed after the reload: click Continue."}`;
	showParkedPick(chooser, ui.pick, ui.summary);
	const run = (from: number) => {
		const mode = chosenMode();
		if (mode === null) return;
		running = true;
		render();
		ui.summary.textContent = "Running...";
		void port
			.exclusive(() =>
				runU12(
					{
						port,
						clearance,
						mode,
						storage: () => localStorage,
						signal: new AbortController().signal,
						attend,
						mark: (step, text) => entries.push({ t: now(), kind: "mark", step, text }),
						onStep: ({ pass, label, detail }) => show(`${pass ? "PASS" : "FAIL"} ${label}: ${detail}`),
					},
					from,
				),
			)
			.then(({ outcomes, paused }) => {
				if (paused) {
					sessionStorage.setItem(PROGRESS_KEY, JSON.stringify({ recordedAt, mode, transcript: transcript() } satisfies Progress));
					phase = "paused";
					ui.summary.textContent = "Reload this page now. The run goes on after it.";
					return;
				}
				forgetProgress();
				phase = "done";
				const failed = outcomes.filter(({ pass }) => !pass).length;
				const stray = framesOutsideU12(entries);
				for (const hex of stray) show(`frame outside the U12 rows: ${hex}`);
				ui.summary.textContent = `${failed === 0 && stray.length === 0 ? "PASS" : "FAIL"}: ${outcomes.length} steps since the reload, ${failed} failed, ${stray.length} frames outside the U12 rows. The verdict decides.`;
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
	};
	ui.osKeyMode.addEventListener("change", render);
	ui.start.addEventListener("click", () => run(0));
	ui.resume.addEventListener("click", () => run(RELOAD_INDEX));
	ui.reload.addEventListener("click", () => location.reload());
	ui.discard.addEventListener("click", () => {
		forgetProgress();
		location.reload();
	});
	ui.download.addEventListener("click", () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u12-${recordedAt.replace(/[:.]/g, "-")}${fakeMode === null ? "" : "-fake"}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});
	render();
} catch (error) {
	ui.about.textContent = `This page cannot start. ${describe(error)}`;
	ui.preconditions.disabled = true;
	ui.start.disabled = true;
}
