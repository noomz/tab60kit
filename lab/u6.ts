/**
 * Plan U6's hardware check: the shipped page's app (web/app.ts), recorded. The clearance names exactly the seven U1
 * rows, which is what SHIPPED sends (probes/policy.test.ts), so the frames are the shipped page's. Run Deep check
 * twice, download each transcript, and give both to tools/u6-verdict.ts. `?fake` runs it on the fake board.
 */
import { labClearance } from "../core/protocol";
import { FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, FakeLocks } from "../testing/fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "../testing/transcript";
import { mountApp } from "../web/app";
import { startWebHid } from "../web/webhid-port";
import { U1_EXPECTED, U1_ROWS } from "./u1-job";

export const U6_PURPOSE = "U6: the shipped page's checks, recorded";

const fake = new URLSearchParams(location.search).has("fake");
const started = new Date();
const now = () => performance.now();
const entries: TranscriptEntry[] = [];

function byId<T extends HTMLElement>(id: string, type: new () => T): T {
	const found = document.getElementById(id);
	if (!(found instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
	return found;
}

const about = byId("about", HTMLParagraphElement);
const app = byId("app", HTMLElement);
const download = byId("download", HTMLButtonElement);

function hardware(): { readonly hid: HID; readonly locks: LockManager } {
	if (!fake) return { hid: navigator.hid, locks: navigator.locks };
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 } });
	return { hid: new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"] }), locks: new FakeLocks() };
}

const transcript = (): Transcript => ({
	format: "tab60kit-transcript/1",
	recordedAt: started.toISOString(),
	environment: { tool: TAB60KIT_COMMIT, userAgent: navigator.userAgent, platform: navigator.platform, page: location.href, fake: fake ? "plain" : "no" },
	entries: [...entries],
});

try {
	if (!fake && !("hid" in navigator)) throw new Error("Use Chrome or Edge: this browser has no WebHID.");
	const { hid, locks } = hardware();
	const { kit, chooser } = startWebHid(hid, locks, {
		clearance: labClearance(U1_ROWS, U6_PURPOSE),
		wrap: (link) => recording(link, (entry) => entries.push(entry), now),
		onEvent: (event) => entries.push({ t: now(), ...event }),
	});
	about.textContent = `Lab U6, tool ${TAB60KIT_COMMIT}, ${fake ? "fake board" : "real WebHID"}. Run Deep check, download the transcript, reload, and do it again.`;
	mountApp(app, kit, chooser);
	download.addEventListener("click", () => {
		const url = URL.createObjectURL(new Blob([JSON.stringify(transcript(), null, 2)], { type: "application/json" }));
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `tab60kit-u6-${started.toISOString().replace(/[:.]/g, "-")}${fake ? "-fake" : ""}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
	});
} catch (error) {
	about.textContent = `This page cannot start. ${error instanceof Error ? error.message : String(error)}`;
}
