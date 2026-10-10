import { expect, test } from "bun:test";
import { LinkLost, asInReport } from "../core/port";
import { type Transcript, parseTranscript, recording } from "./transcript";
import { ScriptedLink, report } from "./scripted";

test("recording stamps every report, close, and loss, and never records a WRITE", async () => {
	let t = 0;
	const inner = new ScriptedLink("iap", [report("1202000000")]);
	let lose = () => undefined as void;
	Object.defineProperty(inner, "lost", { value: new Promise<void>((resolve) => (lose = resolve)) });
	const entries: unknown[] = [];
	const link = recording(inner, (entry) => entries.push(entry), () => ++t);
	const frame = asInReport(new Uint8Array(64));
	frame[0] = 0x12;
	frame[1] = 0x02;
	await link.send(frame as never);
	await link.next(500);
	await link.close();
	lose();
	await inner.lost;
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(entries).toEqual([
		{ t: 1, kind: "out", hex: "1202".padEnd(128, "0") },
		{ t: 2, kind: "in", hex: "1202000000".padEnd(128, "0") },
		{ t: 3, kind: "closed" },
		{ t: 4, kind: "lost" },
	]);
	const write = asInReport(new Uint8Array(64));
	write[0] = 0x1f;
	write[1] = 52;
	await expect(link.send(write as never)).rejects.toThrow(/WRITE/);
	expect(inner.sent).toHaveLength(1);
	expect(entries).toHaveLength(4);
});

test("parseTranscript accepts a round trip and names the first problem it finds", () => {
	const transcript: Transcript = {
		format: "tab60kit-transcript/1",
		recordedAt: "2026-10-10T00:00:00.000Z",
		environment: { tool: "u1" },
		entries: [
			{ t: 0, kind: "pick", reason: "connect", path: "activation", productId: 0x0304, waitMs: 12 },
			{ t: 1, kind: "open-attempt", productId: 0x0304, attempt: 1, error: null },
			{ t: 2, kind: "opened", productId: 0x0304, productName: "USB-HID Keyboard", collections: [{ usagePage: 0xff00, usage: 1, inputReportBytes: 64, outputReportBytes: 64, featureReportBytes: 0 }] },
			{ t: 3, kind: "out", hex: "1202".padEnd(128, "0") },
			{ t: 4, kind: "in", hex: "1202000001".padEnd(128, "0") },
			{ t: 5, kind: "closed" },
			{ t: 6, kind: "lost" },
		],
	};
	expect(parseTranscript(JSON.parse(JSON.stringify(transcript)))).toEqual(transcript);
	expect(() => parseTranscript({ ...transcript, format: "tab60kit-transcript/2" })).toThrow(/format/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: 0, kind: "out", hex: "12" }] })).toThrow(/entry 0: hex/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: 0, kind: "pick", reason: "nope", path: "parked", productId: null, waitMs: 1 }] })).toThrow(/reason/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: "0", kind: "closed" }] })).toThrow(/t is not a number/);
	expect(LinkLost.name).toBe("LinkLost");
});
