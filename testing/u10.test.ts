import { expect, test } from "bun:test";
import { NotCleared, SHIPPED } from "../core/protocol";
import { U1_EXPECTED } from "../lab/u1-job";
import { diffAgainstPrediction, framesOutsideU10, presentUsages, readStore, u10Clearance } from "../lab/u10-run";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import { type TranscriptEntry, recording } from "./transcript";

const live = new AbortController().signal;

/** What lab/u10.ts does on the page: one Read, recorded through the same WebHID shell. */
async function readOnFake(overrides: FakeOptions["overrides"] = [], clearance = u10Clearance()) {
	const board = new FakeTab60({ starting: "official-image", target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 }, overrides });
	const entries: TranscriptEntry[] = [];
	const { port, chooser } = startWebHidLab(new FakeHid(board, { rowAppearsInOpenChooser: ["app"], isActive: () => true }), new FakeLocks(), {
		wrap: (link) => recording(link, (entry) => entries.push(entry)),
		onEvent: (event) => entries.push({ t: 0, ...event }),
	});
	const clicker = setInterval(() => chooser.needsClick !== null && chooser.pick(), 1);
	try {
		const read = await port.exclusive(() => readStore(port, clearance, live)).then(
			(store) => ({ ok: true, store }) as const,
			(error: unknown) => ({ ok: false, error }) as const,
		);
		const sent = entries.flatMap((entry) => (entry.kind === "out" ? [entry.hex] : []));
		return { read, sent, entries, board };
	} finally {
		clearInterval(clicker);
	}
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

test("a clean board reads exactly as predicted, with only the attach reads and the two 0x52 reads on the wire", async () => {
	const { read, sent, entries, board } = await readOnFake();
	if (!read.ok) throw read.error;
	const { store } = read;
	const present = presentUsages();
	expect(present).toHaveLength(66);
	expect(store.entries).toHaveLength(256 + 2 * 66);
	expect(diffAgainstPrediction(store)).toEqual([]);
	expect(framesOutsideU10(entries)).toEqual([]);
	expect(sent.map((frame) => frame.slice(0, 8))).toEqual([
		"12020000",
		"12000000",
		...Array.from({ length: 16 }, (_, a) => `5221${hex2(a)}00`),
		...[1, 2].flatMap((layer) => present.map((k) => `5220${hex2(k)}0${layer}`)),
	]);
	expect(sent.every((frame) => /^0*$/.test(frame.slice(8)))).toBe(true);
	expect(board.violations).toEqual([]);
});

test("a seeded override on layer 1 is the one difference the page shows", async () => {
	const { read } = await readOnFake([{ layer: 1, cell: 5, usage: 0x29, flags: 2 }]);
	if (!read.ok) throw read.error;
	expect(diffAgainstPrediction(read.store)).toEqual(["layer 1 usage 0x04: predicted default, read override 0x29 flags 2"]);
});

test("the shipped clearance reads nothing past the attach", async () => {
	const { read, sent } = await readOnFake([], SHIPPED);
	expect(read.ok ? null : read.error).toBeInstanceOf(NotCleared);
	expect(sent.map((frame) => frame.slice(0, 4))).toEqual(["1202", "1200"]);
});

test("the frame check names every sent frame outside the U10 rows", () => {
	const out = (hex: string): TranscriptEntry => ({ t: 0, kind: "out", hex: hex.padEnd(128, "0") });
	expect(framesOutsideU10([out("12020000"), out("52210300"), out("11010000"), { t: 0, kind: "in", hex: "11".padEnd(128, "0") }, out("12200000")])).toEqual([
		"11010000".padEnd(128, "0"),
		"12200000".padEnd(128, "0"),
	]);
});
