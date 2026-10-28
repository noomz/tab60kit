/**
 * The erases and write addresses U7 may send, as a runtime check in the lab page's link wrap. It is a second gate
 * behind the core's egress audit for the frames that choose where flash changes, and its bytes never come from the
 * codec. Other frames pass to the audit's judgment. This file reaches core/ only for port.ts types and what
 * testing/transcript.ts pulls in (probes/boundaries.ts rule u7-frames-independence).
 */
import type { Link } from "../core/port";
import { type TranscriptEntry, hexOf, recording } from "../testing/transcript";

const FRAME_HEX = 128;
const u32 = (n: number) => [n, n >>> 8, n >>> 16, n >>> 24].map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
const frame = (head: string) => head.padEnd(FRAME_HEX, "0");

/** The version page, the app region, and the vendor's window erase, as (offset, length) in window offsets. */
export const U7_ERASES: readonly string[] = [
	frame("1d000000" + "00000000" + "00020000"),
	frame("1d000000" + "00020000" + "00cc0100"),
	frame("1d000000" + "00000000" + "00ce0100"),
];

/** The start of each 52-byte block: 659 of the image from 0x200, and 4 of the version block from 0. */
export const U7_CURSORS: readonly string[] = [
	...Array.from({ length: 659 }, (_, k) => frame("1e010000" + u32(0x200 + 52 * k))),
	...Array.from({ length: 4 }, (_, k) => frame("1e010000" + u32(52 * k))),
];

/** The lab refused an erase or a write address the core's audit passed, before it reached the wire. */
export class FrameNotAllowed extends Error {
	override readonly name = "FrameNotAllowed";

	constructor(readonly hex: string) {
		super(`${hex.slice(0, 24)} is not an erase or write address U7 may send`);
	}
}

/** Null when `hex` may leave; otherwise the reason it may not. */
export function u7FrameRefusal(hex: string): string | null {
	if (hex.startsWith("1d00") && !U7_ERASES.includes(hex)) return "erase";
	if (hex.startsWith("1e01") && !U7_CURSORS.includes(hex)) return "write address";
	return null;
}

export function onlyU7Targets(link: Link): Link {
	return {
		mode: link.mode,
		lost: link.lost,
		async send(report) {
			const hex = hexOf(report);
			if (u7FrameRefusal(hex) !== null) throw new FrameNotAllowed(hex);
			await link.send(report);
		},
		next: (timeoutMs) => link.next(timeoutMs),
		discardPending: () => link.discardPending(),
		close: () => link.close(),
	};
}

/** Inside the recording, as in U1: a refused frame never reaches the board, and the transcript keeps the attempt. */
export const u7Wrap =
	(sink: (entry: TranscriptEntry) => void, now?: () => number) =>
	(link: Link): Link =>
		recording(onlyU7Targets(link), sink, now);
