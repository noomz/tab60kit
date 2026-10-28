/**
 * Plan U7's hardware check. Drop the vendor updater on the page, tick the preconditions, and Start: the page runs
 * U7_STEPS. It flashes V1.01.13 over itself, deep-checks it, stops at the Bluetooth step until Yes or No, and logs each
 * keylog trial the way the harness does until Enter. A hold-still banner and an unload guard stand while a wire step
 * runs. Download the transcript and run tools/u7-verdict.ts with the same exe. `?fake` runs on the fake board with the
 * synthetic image, and a button types the phrase for each trial.
 */
import { type FlashableImage, imageBytes } from "../core/firmware";
import { FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, FakeLocks } from "../testing/fake-webhid";
import { syntheticFlashable } from "../testing/synthetic-image";
import type { Transcript, TranscriptEntry } from "../testing/transcript";
import { activityText } from "../web/view";
import { startWebHidLab } from "../web/webhid-port";
import { type KeyEvent, type KeylogTrial, PHRASE, perfectTrial } from "./keylog-trial";
import { showParkedPick } from "./pick-wait";
import { preconditionsLocked, tickedBoxes } from "./u1-state";
import { u7Wrap } from "./u7-frames";
import { type Attestation, DONT_PRESS, type TrialStep, U7_PRECONDITIONS, U7_ROWS, type UserStep, attestEntry, catalogImage, framesOutsideU7, runU7, u7Clearance, u7Preconditions } from "./u7-run";

const fakeMode = new URLSearchParams(location.search).get("fake");
const recordedAt = new Date().toISOString();
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
	exe: byId("exe", HTMLInputElement),
	image: byId("image", HTMLParagraphElement),
	dontPress: byId("dont-press", HTMLUListElement),
	start: byId("start", HTMLButtonElement),
	pick: byId("pick", HTMLButtonElement),
	download: byId("download", HTMLButtonElement),
	holdStill: byId("hold-still", HTMLParagraphElement),
	activity: byId("activity", HTMLParagraphElement),
	step: byId("step", HTMLElement),
	stepLabel: byId("step-label", HTMLParagraphElement),
	phraseLine: byId("phrase-line", HTMLParagraphElement),
	phrase: byId("phrase", HTMLElement),
	box: byId("box", HTMLTextAreaElement),
	simulate: byId("simulate", HTMLButtonElement),
	stepQuestion: byId("step-question", HTMLParagraphElement),
	answers: byId("answers", HTMLParagraphElement),
	yes: byId("yes", HTMLButtonElement),
	no: byId("no", HTMLButtonElement),
	summary: byId("summary", HTMLParagraphElement),
	outcomes: byId("outcomes", HTMLOListElement),
	log: byId("log", HTMLPreElement),
};

const log = (line: string) => {
	ui.log.textContent += `${(now() / 1000).toFixed(3)}s ${line}\n`;
};

const entries: TranscriptEntry[] = [];
let image: FlashableImage | null = null;
let running = false;
let done = false;
/** True while a wire step runs: the board may be in update mode, where it cannot type. */
let holdStill = false;

const fakeImage = fakeMode === null ? null : await syntheticFlashable();
const fakeBoard =
	fakeImage === null
		? null
		: new FakeTab60({
				starting: "official-image",
				versionBlock: imageBytes(fakeImage).versionBlock.bytes,
				target: { imageBytes: fakeImage.entry.image.bytes, wireSum32: fakeImage.entry.image.wireSum32 },
			});

function hardware(): { readonly hid: HID; readonly locks: LockManager } {
	if (fakeBoard === null) return { hid: navigator.hid, locks: navigator.locks };
	return { hid: new FakeHid(fakeBoard, { rowAppearsInOpenChooser: ["app", "iap"] }), locks: new FakeLocks() };
}

const transcript = (): Transcript => ({
	format: "tab60kit-transcript/1",
	recordedAt,
	environment: {
		tool: TAB60KIT_COMMIT,
		userAgent: navigator.userAgent,
		platform: navigator.platform,
		page: location.href,
		fake: fakeMode === null ? "no" : fakeMode || "plain",
		...(image === null ? {} : { image: image.entry.id }),
		...u7Preconditions.preconditionEnvironment(entries),
	},
	entries: [...entries],
});

const boxes = U7_PRECONDITIONS.map(({ key, label }) => {
	const box = document.createElement("input");
	box.type = "checkbox";
	box.addEventListener("change", () => {
		const change = u7Preconditions.preconditionChange(entries, key, box.checked, now());
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
for (const key of DONT_PRESS) {
	const item = document.createElement("li");
	item.textContent = key;
	ui.dontPress.append(item);
}

function render(): void {
	const on = tickedBoxes(entries);
	const locked = preconditionsLocked(entries);
	for (const { key, box } of boxes) {
		box.checked = on.has(key);
		box.disabled = locked;
	}
	ui.exe.disabled = locked || fakeImage !== null;
	ui.start.disabled = running || done || locked || image === null || !u7Preconditions.allTicked(entries);
	ui.download.disabled = entries.length === 0;
	ui.holdStill.hidden = !holdStill;
}

ui.exe.addEventListener("change", () => {
	const file = ui.exe.files?.[0];
	image = null;
	render();
	if (file === undefined) return;
	void file
		.arrayBuffer()
		.then((buffer) => catalogImage(new Uint8Array(buffer)))
		.then((found) => {
			if (typeof found === "string") ui.image.textContent = `Not usable: ${found}.`;
			else {
				image = found;
				ui.image.textContent = `Admitted: ${found.entry.version}, ${found.entry.layoutName}.`;
			}
		})
		.catch((error: unknown) => {
			ui.image.textContent = `Could not read the file: ${describe(error)}.`;
		})
		.finally(render);
});

/** Shows a user step and resolves on Yes or No after recording the attestation. */
function attend(step: UserStep): Promise<Attestation> {
	ui.stepLabel.textContent = step.label;
	ui.stepQuestion.textContent = step.question;
	ui.phraseLine.hidden = true;
	ui.box.hidden = true;
	ui.simulate.hidden = true;
	ui.answers.hidden = false;
	ui.step.hidden = false;
	ui.yes.focus();
	return new Promise((resolve) => {
		const answer = (yes: boolean) => () => {
			ui.yes.onclick = null;
			ui.no.onclick = null;
			ui.step.hidden = true;
			const attestation = { answer: yes, keys: [] };
			entries.push(attestEntry(step, attestation, now()));
			render();
			resolve(attestation);
		};
		ui.yes.onclick = answer(true);
		ui.no.onclick = answer(false);
	});
}

/** The harness's trial: log every keydown and keyup in the box, and finish on Enter. */
function type(step: TrialStep): Promise<KeylogTrial> {
	const events: KeyEvent[] = [];
	ui.stepLabel.textContent = step.label;
	ui.stepQuestion.textContent = "";
	ui.phrase.textContent = PHRASE;
	ui.phraseLine.hidden = false;
	ui.box.value = "";
	ui.box.hidden = false;
	ui.answers.hidden = true;
	ui.simulate.hidden = fakeBoard === null;
	ui.step.hidden = false;
	ui.box.focus();
	const wallTime = (event: KeyboardEvent) => performance.timeOrigin + event.timeStamp;
	return new Promise((resolve) => {
		const finish = (trial: KeylogTrial) => {
			ui.box.onkeydown = null;
			ui.box.onkeyup = null;
			ui.simulate.onclick = null;
			ui.step.hidden = true;
			resolve(trial);
		};
		ui.box.onkeydown = (event) => {
			events.push({ t: wallTime(event), ty: "d", c: event.code, k: event.key, r: event.repeat });
			if (event.key !== "Enter") return;
			event.preventDefault();
			if (!event.repeat) finish({ typed: ui.box.value, events });
		};
		ui.box.onkeyup = (event) => {
			events.push({ t: wallTime(event), ty: "u", c: event.code, k: event.key, r: false });
		};
		ui.simulate.onclick = () => finish(perfectTrial(performance.timeOrigin + now()));
	});
}

const show = (line: string) => {
	const li = document.createElement("li");
	li.textContent = line;
	ui.outcomes.append(li);
};

const guard = (event: BeforeUnloadEvent) => {
	if (holdStill) event.preventDefault();
};

try {
	if (fakeMode === null && !("hid" in navigator)) throw new Error("Use Chrome or Edge: this browser has no WebHID.");
	const clearance = u7Clearance();
	const { hid, locks } = hardware();
	const { port, chooser } = startWebHidLab(hid, locks, {
		wrap: u7Wrap((entry) => entries.push(entry), now),
		onEvent: (event) => entries.push({ t: now(), ...event }),
	});
	const recordVisibility = () => entries.push({ t: now(), kind: "visibility", state: document.visibilityState === "hidden" ? "hidden" : "visible" });
	recordVisibility();
	document.addEventListener("visibilitychange", recordVisibility);
	addEventListener("beforeunload", guard);
	if (fakeImage !== null) {
		image = fakeImage;
		ui.image.textContent = `Fake board: the synthetic image ${fakeImage.entry.id}.`;
	}
	ui.about.textContent = `Lab clearance: ${U7_ROWS.join(", ")}. Tool ${TAB60KIT_COMMIT}. ${fakeMode === null ? "Real WebHID." : "Fake board."}`;
	showParkedPick(chooser, ui.pick, ui.summary);
	ui.start.addEventListener("click", () => {
		const flashing = image;
		if (flashing === null) return;
		running = true;
		render();
		ui.summary.textContent = "Running...";
		void port
			.exclusive(() =>
				runU7({
					port,
					clearance,
					image: flashing,
					signal: new AbortController().signal,
					attend,
					type,
					mark: (step, text) => {
						entries.push({ t: now(), kind: "mark", step, text });
						holdStill = text === "begin";
						render();
					},
					progress: (activity) => {
						ui.activity.textContent = activityText(activity);
					},
					onStep: ({ id, pass, label, detail }) => {
						if (id === "flash" || id === "deep-check") holdStill = false;
						show(`${pass ? "PASS" : "FAIL"} ${label}: ${detail}`);
						render();
					},
				}),
			)
			.then((outcomes) => {
				const failed = outcomes.filter(({ pass }) => !pass).length;
				const stray = framesOutsideU7(entries);
				for (const head of stray) show(`frame outside the U7 rows: ${head}`);
				ui.summary.textContent = `${failed === 0 && stray.length === 0 ? "PASS" : "FAIL"}: ${outcomes.length} steps, ${failed} failed, ${stray.length} frames outside the U7 rows. The verdict decides.`;
			})
			.catch((error: unknown) => {
				ui.summary.textContent = `FAIL: ${describe(error)}. Click Connect on the main page to see where the board is; the vendor updater on a Windows PC is the recovery.`;
				log(`run failed: ${describe(error)}`);
			})
			.finally(() => {
				running = false;
				done = true;
				holdStill = false;
				ui.step.hidden = true;
				ui.activity.textContent = "";
				render();
			});
	});
	ui.download.addEventListener("click", () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u7-${recordedAt.replace(/[:.]/g, "-")}${fakeMode === null ? "" : "-fake"}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});
	render();
} catch (error) {
	ui.about.textContent = `This page cannot start. ${describe(error)}`;
	ui.preconditions.disabled = true;
	ui.start.disabled = true;
}
