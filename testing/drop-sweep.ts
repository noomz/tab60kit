/**
 * The lever that proves "a lost link cannot strand or brick the board" for the model the fake encodes.
 * It answers the idempotency questions for every point of a flash: what if the link drops right here, and what
 * if the MCU also resets right here.
 */
import type { FlashableImage } from "../core/firmware";
import { createKit } from "../core/kit";
import { type Clearance, labClearance } from "../core/protocol";
import { FakeTab60, type FakeOptions } from "./fake-tab60";

export interface SweepFailure {
	readonly packet: number;
	readonly resetOnLoss: boolean;
	readonly rewrite: boolean;
	readonly starting: FakeOptions["starting"];
	readonly why: string;
}

export const STARTING_STATES = ["official-image", "untrusted-image", "update-mode-erased", "update-mode-partial-version-block"] as const satisfies readonly FakeOptions["starting"][];

/** Every row the flash job sends: the seven U1 rows and the three flash-write rows reviewed for U5. */
export const FLASH_CLEARANCE: Clearance = labClearance(
	["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp", "erase", "setWriteAddress", "write"],
	"U5 drop sweep, fake board only",
);

export interface SweepReport {
	readonly runs: number;
	readonly failures: readonly SweepFailure[];
}

/**
 * The fake runs a virtual clock, so the link gate's 15 s of probes cost no wall time, and its probe packets are
 * drop points like any other. For each starting state and rewrite setting, a clean run counts the packets; then the
 * link drops right before each one, with and without an MCU reset. Every run must finish official, leave no violation,
 * and leave a board that boots normal mode over the entry's version block.
 * testing/reconcile-model.ts runs the same loop over the decide tables on a toy board; this sweep adds bytes,
 * addresses, the real encoder, and the fake's erase order.
 */
export async function dropSweep(image: FlashableImage, starting: readonly FakeOptions["starting"][] = STARTING_STATES): Promise<SweepReport> {
	const target = { imageBytes: image.entry.image.bytes, wireSum32: image.entry.image.wireSum32 };
	const failures: SweepFailure[] = [];
	let runs = 0;
	const run = async (options: FakeOptions, rewrite: boolean) => {
		const board = new FakeTab60({ ...options, target, clock: "virtual", reenumerateAfterMs: 0 });
		const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite });
		runs++;
		const boot = await board.bootTarget();
		const problems: string[] = [];
		if (end.kind !== "finished" || end.result.kind !== "official") problems.push(`ended ${end.kind}${end.kind === "stopped" ? ` (${JSON.stringify(end.reason)})` : ""}`);
		if (board.violations.length > 0) problems.push(`violations ${JSON.stringify(board.violations.slice(0, 3))}${board.violations.length > 3 ? ` and ${board.violations.length - 3} more` : ""}`);
		if (boot.mode !== "app" || boot.versionPageSha256 !== image.entry.versionBlock.sha256) problems.push(`boots ${boot.mode} over ${boot.versionPageSha256}`);
		return { board, why: problems.join("; ") };
	};
	for (const from of starting) {
		for (const rewrite of [false, true]) {
			const clean = await run({ starting: from, target }, rewrite);
			if (clean.why !== "") failures.push({ packet: -1, resetOnLoss: false, rewrite, starting: from, why: `clean run: ${clean.why}` });
			for (let packet = 0; packet < clean.board.packetsReceived; packet++) {
				for (const resetOnLoss of [false, true]) {
					const { why } = await run({ starting: from, target, loseLinkAtPacket: packet, resetOnLoss }, rewrite);
					if (why !== "") failures.push({ packet, resetOnLoss, rewrite, starting: from, why });
				}
			}
		}
	}
	return { runs, failures };
}

if (import.meta.main) {
	const { syntheticFlashable } = await import("./synthetic-image");
	const started = performance.now();
	const asked = process.argv.slice(2);
	const unknown = asked.filter((name) => !(STARTING_STATES as readonly string[]).includes(name));
	if (unknown.length > 0) throw new Error(`unknown starting states: ${unknown.join(", ")}`);
	const report = await dropSweep(await syntheticFlashable(), asked.length > 0 ? STARTING_STATES.filter((name) => asked.includes(name)) : STARTING_STATES);
	console.log(JSON.stringify({ runs: report.runs, failures: report.failures.length, seconds: Math.round((performance.now() - started) / 100) / 10, examples: report.failures.slice(0, 5) }));
	process.exit(report.failures.length === 0 ? 0 : 1);
}
