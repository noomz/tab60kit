/**
 * The lever that proves "a lost link cannot strand or brick the board" for the model the fake encodes.
 * It answers the idempotency questions for every point of a flash: what if the link drops right here, and what
 * if the MCU also resets right here.
 */
import type { FlashableImage } from "../core/firmware";
import { createKit } from "../core/kit";
import { notImplemented } from "../core/units";
import { FakeTab60, type FakeOptions } from "./fake-tab60";

export interface SweepFailure {
	readonly packet: number;
	readonly resetOnLoss: boolean;
	readonly rewrite: boolean;
	readonly starting: FakeOptions["starting"];
	readonly why: string;
}

/**
 * The fake runs a virtual clock, so the link gate's 15 s of probes cost no wall time, and its probe packets are
 * drop points like any other.
 * TODO:
 *   target = { imageBytes: image.entry.image.bytes, wireSum32: image.entry.image.wireSum32 }
 *   for starting of ["official-image", "untrusted-image", "update-mode-erased", "update-mode-partial-version-block"],
 *   for rewrite of [false, true]:
 *     clean = new FakeTab60({ starting, target }); run createKit(clean.port()).makeOfficial(image, { rewrite })
 *     n = clean.packetsReceived
 *     for packet in 0..n-1, for resetOnLoss in [false, true]:
 *       board = new FakeTab60({ starting, target, loseLinkAtPacket: packet, resetOnLoss })
 *       end = await createKit(board.port()).makeOfficial(image, { rewrite })
 *       failure unless all hold:
 *         end.kind === "finished" and end.result is official
 *         board.violations is empty (the fake's default descending erase order makes a one-command erase fail here)
 *         board.bootTarget() is app with the entry's version block hash
 *   4 starting states x 2 rewrite x 2 reset modes x about 720 packets (30 of them gate probes), so about 11,500 runs
 *   against an in-memory board. Cheap enough for every push (a guess until U5 measures it).
 *   testing/reconcile-model.ts already runs the same loop over C's decide tables on a toy board; this sweep adds bytes,
 *   addresses, and the real encoder.
 */
export async function dropSweep(image: FlashableImage): Promise<readonly SweepFailure[]> {
	return notImplemented(`dropSweep(${image.entry.id}) with ${createKit.name} on ${FakeTab60.name}`);
}
