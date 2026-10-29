import { expect, test } from "bun:test";
import { U6_SEQUENCE, evaluateU6 } from "../lab/u6-checks";
import { U1_EXPECTED, U1_ROWS } from "../lab/u1-job";
import { labClearance } from "../core/protocol";
import { screenFor } from "../web/screens";
import { viewFor } from "../web/view";
import { startWebHid } from "../web/webhid-port";
import { FakeTab60 } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "./transcript";

/** What lab/u6.ts does on the page: the shipped app's Connect, then Deep check, recorded. */
async function session(): Promise<{ readonly transcript: Transcript; readonly flashMap: readonly string[]; readonly boot: string | null }> {
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 } });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true });
	const entries: TranscriptEntry[] = [];
	const { kit, chooser } = startWebHid(hid, new FakeLocks(), {
		clearance: labClearance(U1_ROWS, "U6 test"),
		wrap: (link) => recording(link, (entry) => entries.push(entry)),
		onEvent: (event) => entries.push({ t: 0, ...event }),
	});
	const clicker = setInterval(() => chooser.needsClick !== null && chooser.pick(), 1);
	try {
		expect(await kit.check("quick")).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "quick" } });
		expect(await kit.check("deep")).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "deep" } });
	} finally {
		clearInterval(clicker);
	}
	const view = viewFor(screenFor({ kind: "kit", state: kit.state, reading: null, keymap: { overrides: new Map(), osMode: null }, caps: kit.capabilities() }), null);
	return {
		transcript: { format: "tab60kit-transcript/1", recordedAt: "test", environment: { tool: "test", fake: "plain" }, entries },
		flashMap: view.flashMap?.map((row) => `${row.region} ${row.range}: ${row.detail ?? row.finding}`) ?? [],
		boot: view.boot?.text ?? null,
	};
}

test("the shipped page's Connect then Deep check, twice on the fake board: identical apart from timing, U1's frames in order, the sum official", async () => {
	const first = await session();
	const second = await session();
	const checks = await evaluateU6(first.transcript, second.transcript);
	const byTitle = Object.fromEntries(checks.map((check) => [check.title, check]));
	expect(checks.map((check) => [check.title, check.pass])).toEqual([
		["Both transcripts record the real board from a clean build", false],
		["The two transcripts are identical apart from timing", true],
		["first: Connect then Deep check sends U1's frames in order", true],
		["second: Connect then Deep check sends U1's frames in order", true],
		// The fake's version block is synthetic; the real block's bytes are vendor bytes the repo does not hold.
		["Every version page read, in both modes, hashes to the catalog's V1.01.13 block (official by its bytes)", false],
		["SUM over the image answers the catalog's wire sum (official by its sum)", true],
	]);
	expect(byTitle["Every version page read, in both modes, hashes to the catalog's V1.01.13 block (official by its bytes)"]?.detail).toStartWith("6 reads");
	expect(U6_SEQUENCE).toHaveLength(19);
});

test("the page's flash map after a deep check: bootloader not checkable with its fingerprint, the firmware official by its sum", async () => {
	const { flashMap, boot } = await session();
	expect(flashMap[0]).toMatch(/^Bootloader 0x00000–0x03000: Not checkable over USB: only the 52-byte BL info window is readable\. Fingerprint [0-9a-f]{16}\.$/);
	expect(flashMap[1]).toStartWith("Version page 0x03000–0x03200: Not recognized:");
	expect(flashMap[2]).toBe("Firmware 0x03200–0x0b7dc: Official V1.01.13, by its sum.");
	expect(flashMap[3]).toStartWith("Firmware 0x0b7dc–0x1fe00: Not checked:");
	expect(flashMap[4]).toStartWith("Option bytes 0x1fe00–0x20000: Not checkable over USB");
	expect(boot).toBe("When the keyboard restarts, it runs its current firmware, which this tool hasn't verified.");
});

test("a transcript that differs anywhere but in timing fails the identity check, and names the entry", async () => {
	const first = await session();
	const entries = first.transcript.entries.map((entry) => (entry.kind === "in" && entry.hex.startsWith("1d01") ? { ...entry, hex: `1d010000ffffffff${entry.hex.slice(16)}` } : entry));
	const checks = await evaluateU6(first.transcript, { ...first.transcript, entries });
	const identity = checks.find((check) => check.title === "The two transcripts are identical apart from timing");
	expect(identity?.pass).toBe(false);
	expect(identity?.detail).toContain("in 1d010000");
	expect(checks.find((check) => check.title.startsWith("SUM"))?.pass).toBe(false);
});

test("an empty confirm chooser parks the pick and tells the page, so a Pick click finishes the deep check (the 2026-10-18 hardware stall)", async () => {
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 } });
	// As on the real board: the confirm chooser opens before the keyboard re-enumerates and comes back empty at once.
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["iap"], isActive: () => true });
	const { kit, chooser } = startWebHid(hid, new FakeLocks());
	const told: string[] = [];
	chooser.subscribe(() => {
		const want = chooser.needsClick;
		told.push(want === null ? "cleared" : want.reason);
		// What the page's Pick button does once the redraw shows it.
		if (want !== null) setTimeout(() => chooser.pick(), 10);
	});
	await kit.check("quick");
	const end = await kit.check("deep");
	expect(told).toEqual(["confirm-normal-mode", "cleared"]);
	expect(end).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "deep" } });
	expect(board.mode).toBe("app");
});
