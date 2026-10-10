import { expect, test } from "bun:test";
import { type Link, LinkLost, asInReport } from "../core/port";
import { type Transcript, type TranscriptEntry, parseTranscript, recording } from "./transcript";
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

test("recording keeps the reports discardPending drops and marks a send that rejected", async () => {
	const stale = report("1220000000");
	const inner: Link = {
		mode: "app",
		lost: new Promise<void>(() => undefined),
		send: async () => {
			throw new LinkLost("unplugged");
		},
		next: async () => {
			throw new Error("not read in this test");
		},
		discardPending: () => [stale],
		close: async () => undefined,
	};
	let t = 0;
	const entries: TranscriptEntry[] = [];
	const link = recording(inner, (entry) => entries.push(entry), () => ++t);
	expect(link.discardPending()).toEqual([stale]);
	const frame = asInReport(new Uint8Array(64));
	frame[0] = 0x11;
	frame[1] = 0x01;
	await expect(link.send(frame as never)).rejects.toBeInstanceOf(LinkLost);
	expect(entries).toEqual([
		{ t: 1, kind: "discarded", hex: "1220000000".padEnd(128, "0") },
		{ t: 2, kind: "out", hex: "1101".padEnd(128, "0") },
		{ t: 3, kind: "send-failed", hex: "1101".padEnd(128, "0"), error: "LinkLost: unplugged" },
	]);
});

test("parseTranscript accepts a round trip and names the first problem it finds", () => {
	const transcript: Transcript = {
		format: "tab60kit-transcript/1",
		recordedAt: "2026-10-10T00:00:00.000Z",
		environment: { tool: "u1", fake: "no" },
		entries: [
			{ t: 0, kind: "pick", reason: "connect", path: "activation", productId: 0x0304, waitMs: 12 },
			{ t: 1, kind: "open-attempt", productId: 0x0304, attempt: 1, error: null },
			{ t: 2, kind: "opened", reason: "connect", productId: 0x0304, productName: "USB-HID Keyboard", collections: [{ usagePage: 0xff00, usage: 1, inputReportBytes: 64, outputReportBytes: 64, featureReportBytes: 0 }] },
			{ t: 3, kind: "out", hex: "1202".padEnd(128, "0") },
			{ t: 4, kind: "in", hex: "1202000001".padEnd(128, "0") },
			{ t: 5, kind: "closed" },
			{ t: 6, kind: "lost" },
			{ t: 7, kind: "discarded", hex: "1220".padEnd(128, "0") },
			{ t: 8, kind: "send-failed", hex: "1101".padEnd(128, "0"), error: "LinkLost: unplugged" },
			{ t: 9, kind: "close-timeout", productId: 0x1304 },
			{ t: 10, kind: "visibility", state: "hidden" },
			{ t: 11, kind: "typing", chars: 3 },
			{ t: 12, kind: "granted", productId: 0x1304 },
		],
	};
	expect(parseTranscript(JSON.parse(JSON.stringify(transcript)))).toEqual(transcript);
	expect(() => parseTranscript({ ...transcript, environment: { tool: "u1" } })).toThrow(/environment.fake is missing/);
	expect(() => parseTranscript({ ...transcript, environment: { tool: "u1", fake: false } })).toThrow(/environment.fake is not a string/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: 0, kind: "visibility", state: "prerender" }] })).toThrow(/unknown visibility/);
	expect(() => parseTranscript({ ...transcript, format: "tab60kit-transcript/2" })).toThrow(/format/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: 0, kind: "out", hex: "12" }] })).toThrow(/entry 0: hex/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: 0, kind: "pick", reason: "nope", path: "parked", productId: null, waitMs: 1 }] })).toThrow(/reason/);
	const { reason: _reason, ...noReason } = transcript.entries[2] as Extract<TranscriptEntry, { kind: "opened" }>;
	expect(() => parseTranscript({ ...transcript, entries: [noReason] })).toThrow(/entry 0: reason is not a string/);
	expect(() => parseTranscript({ ...transcript, entries: [{ t: "0", kind: "closed" }] })).toThrow(/t is not a number/);
	expect(LinkLost.name).toBe("LinkLost");
});
