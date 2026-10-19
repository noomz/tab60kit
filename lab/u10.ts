/**
 * Plan U10's hardware check. After a battery pull, tick the preconditions and Read the store: every entry must match
 * the clean-store prediction, and the transcript must carry only the U10 rows. Download it and run tools/u10-verdict.ts,
 * which writes the capture for the commit that moves cfgReadKeys and cfgReadKey to "confirmed". `?fake` runs on the fake board; `?fake=override` seeds one override on layer 1 so a difference shows.
 */
import { FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, FakeLocks } from "../testing/fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "../testing/transcript";
import { startWebHidLab } from "../web/webhid-port";
import { U1_EXPECTED } from "./u1-job";
import { preconditionsLocked, tickedBoxes } from "./u1-state";
import { U10_PRECONDITIONS, U10_ROWS, diffAgainstPrediction, framesOutsideU10, readStore, u10Clearance, u10Preconditions } from "./u10-run";

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
	read: byId("read", HTMLButtonElement),
	pick: byId("pick", HTMLButtonElement),
	download: byId("download", HTMLButtonElement),
	summary: byId("summary", HTMLParagraphElement),
	diffs: byId("diffs", HTMLUListElement),
	log: byId("log", HTMLPreElement),
};

const log = (line: string) => {
	ui.log.textContent += `${(now() / 1000).toFixed(3)}s ${line}\n`;
};

function hardware(): { readonly hid: HID; readonly locks: LockManager } {
	if (fakeMode === null) return { hid: navigator.hid, locks: navigator.locks };
	const board = new FakeTab60({
		starting: "official-image",
		target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 },
		overrides: fakeMode === "override" ? [{ layer: 1, cell: 5, usage: 0x29, flags: 2 }] : [],
	});
	return { hid: new FakeHid(board, { rowAppearsInOpenChooser: ["app"] }), locks: new FakeLocks() };
}

const transcript = (): Transcript => ({
	format: "tab60kit-transcript/1",
	recordedAt: started.toISOString(),
	environment: { tool: TAB60KIT_COMMIT, userAgent: navigator.userAgent, platform: navigator.platform, page: location.href, fake: fakeMode === null ? "no" : fakeMode || "plain", ...u10Preconditions.preconditionEnvironment(entries) },
	entries: [...entries],
});

let reading = false;
const boxes = U10_PRECONDITIONS.map(({ key, label }) => {
	const box = document.createElement("input");
	box.type = "checkbox";
	box.addEventListener("change", () => {
		const change = u10Preconditions.preconditionChange(entries, key, box.checked, now());
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

/** One Read per page load: the verdict expects one 16-frame layer 0 read, so another read needs a reload. */
function render(): void {
	const on = tickedBoxes(entries);
	const locked = preconditionsLocked(entries);
	for (const { key, box } of boxes) {
		box.checked = on.has(key);
		box.disabled = locked;
	}
	ui.read.disabled = reading || locked || !u10Preconditions.allTicked(entries);
	ui.download.disabled = entries.length === 0;
}

try {
	if (fakeMode === null && !("hid" in navigator)) throw new Error("Use Chrome or Edge: this browser has no WebHID.");
	const clearance = u10Clearance();
	const { hid, locks } = hardware();
	const { port, chooser } = startWebHidLab(hid, locks, {
		wrap: (link) => recording(link, (entry) => entries.push(entry), now),
		onEvent: (event) => entries.push({ t: now(), ...event }),
	});
	ui.about.textContent = `Lab clearance: ${U10_ROWS.join(", ")}. Tool ${TAB60KIT_COMMIT}. ${fakeMode === null ? "Real WebHID." : "Fake board."}`;
	chooser.subscribe(() => {
		ui.pick.hidden = chooser.needsClick === null;
	});
	ui.pick.addEventListener("click", () => chooser.pick());
	ui.read.addEventListener("click", () => {
		reading = true;
		render();
		ui.summary.textContent = "Reading...";
		ui.diffs.replaceChildren();
		void port
			.exclusive(() => readStore(port, clearance, "windows", new AbortController().signal))
			.then((read) => {
				const diffs = diffAgainstPrediction(read, "windows");
				const stray = framesOutsideU10(entries);
				const layer0 = read.entries.filter((entry) => entry.layer === 0).length;
				ui.summary.textContent =
					`${diffs.length === 0 && stray.length === 0 ? "PASS" : "FAIL"}: ${layer0} layer-0 entries and ${read.entries.length - layer0} layer 1-2 entries read, ` +
					`${diffs.length} differ from the clean prediction, ${stray.length} frames outside the U10 rows.`;
				ui.diffs.replaceChildren(
					...[...diffs, ...stray.map((hex) => `frame outside the U10 rows: ${hex}`)].map((line) => {
						const li = document.createElement("li");
						li.textContent = line;
						return li;
					}),
				);
				log(`read ${read.entries.length} entries`);
			})
			.catch((error: unknown) => {
				ui.summary.textContent = `FAIL: ${describe(error)}`;
				log(`read failed: ${describe(error)}`);
			})
			.finally(() => {
				reading = false;
				render();
			});
	});
	ui.download.addEventListener("click", () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u10-${started.toISOString().replace(/[:.]/g, "-")}${fakeMode === null ? "" : "-fake"}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});
	render();
} catch (error) {
	ui.about.textContent = `This page cannot start. ${describe(error)}`;
	ui.preconditions.disabled = true;
	ui.read.disabled = true;
}
