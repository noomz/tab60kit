/**
 * A behavioral model of the TAB 60 on the vendor interface, for Node tests. It is R1's protocol spec and R4's
 * app command map in executable form. Every behavior it models is INFERRED until a hardware transcript (U1, U7)
 * confirms it; when the two disagree, the transcript wins and this file changes.
 *
 * It must not import the host codec (candidate B). It implements R1's and R4's tables from the documents with its
 * own byte handling, so a codec bug in the core and the same bug in the fake cannot cancel out. probes/boundaries.ts
 * fails the build when this file's imports reach core/ anywhere but port.ts, the seam it implements, and units.ts.
 * The facts it checks against (the target image's length and wire sum) come in through FakeOptions from the test.
 *
 * It also records violations: anything a real board might accept that this tool must never send.
 */
import type { DevicePort, Mode } from "../core/port";
import { type Sha256, notImplemented } from "../core/units";
import { notImplementedPort } from "./transcript";

export interface FakeOptions {
	/** What the board holds at the start of the test. */
	readonly starting: "official-image" | "untrusted-image" | "update-mode-erased" | "update-mode-partial-version-block";
	/** The image a correct run ends with, from the catalog entry the test flashes. */
	readonly target: { readonly imageBytes: number; readonly wireSum32: number };
	/** Lose the link right before the board would receive this output report (counted from 0 across the run). */
	readonly loseLinkAtPacket?: number;
	/** On that loss, also reset the MCU: SRAM is cleared and the IAP decides from the version page. */
	readonly resetOnLoss?: boolean;
	/**
	 * The order one ERASE command clears its pages in. Nothing documents the IAP's order, so tests default to
	 * "descending", the order in which an erase that covers the version page clears it last.
	 */
	readonly eraseOrder?: "ascending" | "descending";
	/** The board answers this command with the FF AA error marker once. */
	readonly refuseOnce?: { readonly cmd: number; readonly sub: number };
}

export type Violation =
	/** ERASE, SUM, CRC, set-address, or WRITE that touches [0x0, 0x3000) or [0x1FE00, ...), or wraps 32 bits. */
	| { readonly kind: "outside-window"; readonly cmd: number; readonly offset: number; readonly length: number }
	/** The version block's magic written while the image range did not sum to the target's wire sum. */
	| { readonly kind: "version-block-before-verified-image" }
	/** An app page changed while the version page still held its magic: a reset right then would boot a damaged image. */
	| { readonly kind: "app-changed-under-valid-page"; readonly page: number }
	/** A config command (0x40 and up) sent during a flash job, or any command in a mode that lacks it. */
	| { readonly kind: "wrong-mode"; readonly cmd: number; readonly mode: Mode };

/**
 * TODO, the model:
 *   flash: 128 KiB. [0x0, 0x3000) holds sentinel bytes; any change there is a violation and fails the test.
 *   app mode answers 0x10, 0x11, 0x12 (R4 table), and the config family as SRAM no-ops; anything else -> FF AA.
 *   IAP answers 0x11, 0x12, 0x1D, 0x1E, 0x1F (R1 table).
 *     ERASE clears its pages one at a time in options.eraseOrder; each page is a point where loseLinkAtPacket may land.
 *     write address is a window offset; WRITE stores its payload at it, as sent, and acks with the next offset.
 *     SUM and CRC run over the stored bytes. Whether the IAP stores plain or wire bytes cannot be seen over USB,
 *     so storing what was sent and summing it reproduces the board's answers (B) with no key table.
 *   RESET re-enumerates: the old link loses, a new link with the other product ID becomes openable.
 *   Boot decision on reset: the version page's magic 0x5AA5 at 0xB0 present and the words from 0x78 not 0xFF -> app,
 *     otherwise stay in IAP (R1, INFERRED).
 *   loseLinkAtPacket: the old link rejects LinkLost, and the port reopens in the current mode on the next open().
 *   clock: virtual. It moves only through sleep() and each command's modeled duration, so the link gate's 15 s of
 *     probes cost no wall time.
 */
export class FakeTab60 {
	constructor(readonly options: FakeOptions) {}

	/** A port that reconnects at once, like a polling Node shell. */
	port(): DevicePort {
		return notImplementedPort(`FakeTab60(${this.options.starting}).port`);
	}

	get violations(): readonly Violation[] {
		return notImplemented("violations");
	}

	/** Where the board would go on its next reset, and what its version page holds. */
	bootTarget(): { readonly mode: Mode; readonly versionPageSha256: Sha256 | "erased" } {
		return notImplemented("bootTarget");
	}

	/** Output reports received so far. The drop sweep runs once clean to learn the count. */
	get packetsReceived(): number {
		return notImplemented("packetsReceived");
	}
}
