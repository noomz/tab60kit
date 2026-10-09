/**
 * Recorded sessions with a real board: the golden fixtures behind the fake board and the replay tests, and the
 * capture that moves a G1 row from "reviewed" to "confirmed" (protocol.ts Maturity).
 *
 * A transcript never carries firmware. WRITE payloads are stored as their length and SHA-256, by construction in
 * `recording`. Replay compares the hash of what the core sends against the recorded hash, so golden tests stay
 * byte-exact without redistributing vendor bytes.
 */
import type { DevicePort, Link } from "../core/port";
import type { Sha256 } from "../core/units";
import { notImplemented } from "../core/units";

export interface Transcript {
	readonly format: "tab60kit-transcript/1";
	readonly recordedAt: string;
	/** Tool version and commit, OS, browser, and whether Karabiner-Elements was running. */
	readonly environment: Readonly<Record<string, string>>;
	readonly entries: readonly TranscriptEntry[];
}

export type TranscriptEntry =
	| { readonly t: number; readonly kind: "opened"; readonly productId: number; readonly productName: string }
	| { readonly t: number; readonly kind: "out"; readonly hex: string }
	| {
			readonly t: number;
			readonly kind: "out-write";
			/** Bytes 0..3 of the WRITE packet. */
			readonly header: string;
			readonly payloadBytes: number;
			readonly payloadSha256: Sha256;
	  }
	| { readonly t: number; readonly kind: "in"; readonly hex: string }
	| { readonly t: number; readonly kind: "lost" | "closed" };

/** Wraps a link so every report is appended to `sink`. TODO: byte 0 == 0x1F -> "out-write" with the payload hashed. */
export function recording(link: Link, sink: (entry: TranscriptEntry) => void): Link {
	return notImplemented(`recording(${link.mode}, ${sink.name})`);
}

/**
 * A port that plays a transcript back. TODO: each output report must equal the next recorded "out" entry (or match
 * an "out-write" by header and payload hash); the reply is the next "in" entry. Any divergence throws with the index.
 */
export function replayPort(transcript: Transcript): DevicePort {
	return notImplementedPort(`replayPort(${transcript.entries.length} entries)`);
}

export function notImplementedPort(what: string): DevicePort {
	return {
		open: async () => notImplemented(`${what}.open`),
		exclusive: async () => notImplemented(`${what}.exclusive`),
		clock: { now: () => notImplemented(`${what}.clock.now`), sleep: async () => notImplemented(`${what}.clock.sleep`) },
	};
}
