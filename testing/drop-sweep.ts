/**
 * The lever that proves "a lost link cannot strand or brick the board" for the model the fake encodes.
 * It answers the idempotency questions for every point of a flash: what if the link drops right here, and what
 * if the MCU also resets right here.
 */
import { type FlashableImage, imageBytes } from "../core/firmware";
import { createKit } from "../core/kit";
import { type Clearance, labClearance } from "../core/protocol";
import { FakeTab60, type FakeOptions } from "./fake-tab60";

/** Where a run starts. "holds-target" is the board the user has today: it converges with no write unless asked. */
export const STARTS = [
	"official-image",
	"untrusted-image",
	"update-mode-erased",
	"update-mode-partial-version-block",
	"update-mode-damaged-image",
	"holds-target",
] as const;
export type Start = (typeof STARTS)[number];

/**
 * How the IAP behaves where the rulings add a path. An ERASE that starts past offset 0, which the vendor never sends
 * (U2 D1): it erases, or it refuses with FF AA, or it never answers; the last two run eraseWindow's fallback, the
 * vendor's one window erase. "mute-write": it writes block 100 and loses the ack, so the block is resent (D5).
 */
const IAP_OPTIONS = {
	erases: {},
	"error-marker": { offsetErase: "error-marker" },
	silent: { offsetErase: "silent" },
	"mute-write": { writeFault: { at: 100, times: 1, kind: "mute" } },
} as const satisfies Record<string, Partial<FakeOptions>>;
export type IapBehavior = keyof typeof IAP_OPTIONS;
export const IAP_BEHAVIORS = Object.keys(IAP_OPTIONS) as readonly IapBehavior[];

export interface SweepFailure {
	readonly start: Start;
	readonly iap: IapBehavior;
	readonly rewrite: boolean;
	readonly packet: number;
	/** "before": the board never saw the packet. "after": it executed the packet and the reply was lost. */
	readonly lost: "before" | "after";
	readonly resetOnLoss: boolean;
	readonly why: string;
}

/** Every row the flash job sends: the seven U1 rows, the three flash-write rows reviewed for U5, and get write address (U7). */
export const FLASH_CLEARANCE: Clearance = labClearance(
	["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp", "erase", "setWriteAddress", "getWriteAddress", "write"],
	"U5 drop sweep, fake board only",
);

/**
 * One of `count` disjoint slices of the run set. Every run, the clean ones included, has a sequence number in the
 * fixed order of the loops below, and shard `index` takes the runs whose number is `index` modulo `count`: the slices
 * are disjoint, together they are the whole set, and each is a fair share of every start and erase behavior.
 */
export interface Shard {
	readonly index: number;
	readonly count: number;
}

export const inShard = (sequence: number, shard: Shard | undefined): boolean => shard === undefined || sequence % shard.count === shard.index;

export function parseShard(text: string): Shard {
	const match = /^(\d+)\/(\d+)$/.exec(text);
	const shard = match === null ? undefined : { index: Number(match[1]), count: Number(match[2]) };
	if (shard === undefined || shard.count < 1 || shard.index >= shard.count) throw new Error(`bad shard "${text}": want INDEX/COUNT with INDEX < COUNT, like 0/4`);
	return shard;
}

export interface SweepReport {
	/** The runs this call made: all of them, or this shard's slice. */
	readonly runs: number;
	/** The runs in the whole set. The runs of all shards add up to this. */
	readonly total: number;
	readonly failures: readonly SweepFailure[];
}

function startOptions(start: Start, image: FlashableImage): Pick<FakeOptions, "starting" | "versionBlock"> {
	if (start === "holds-target") return { starting: "update-mode-official-image", versionBlock: imageBytes(image).versionBlock.bytes };
	return { starting: start };
}

/**
 * The fake runs a virtual clock, so the link gate's 15 s of probes cost no wall time, and its probe packets are
 * drop points like any other. For each start, IAP behavior, and rewrite setting, a clean run counts the packets; then
 * the link drops at each one, before the board sees it and after it executed it, with and without an MCU reset. Every
 * run must finish official, leave no violation, and leave a board that boots normal mode over the entry's version
 * block.
 * testing/reconcile-model.ts runs the same loop over the decide tables on a toy board; this sweep adds bytes,
 * addresses, the real encoder, and the fake's erase order.
 */
export async function dropSweep(image: FlashableImage, starts: readonly Start[] = STARTS, iaps: readonly IapBehavior[] = IAP_BEHAVIORS, shard?: Shard): Promise<SweepReport> {
	const target = { imageBytes: image.entry.image.bytes, wireSum32: image.entry.image.wireSum32 };
	const failures: SweepFailure[] = [];
	let runs = 0;
	let total = 0;
	const run = async (options: Partial<FakeOptions>, start: Start, iap: IapBehavior, rewrite: boolean) => {
		const board = new FakeTab60({ ...startOptions(start, image), ...IAP_OPTIONS[iap], ...options, target, clock: "virtual", reenumerateAfterMs: 0 });
		const kit = createKit(board.port(), FLASH_CLEARANCE);
		// A job that throws (a bug) leaves the kit stopped with an error reason, which counts as this run's failure.
		const end = await kit.makeOfficial(image, { rewrite }).catch(() => kit.state);
		const boot = await board.bootTarget();
		const problems: string[] = [];
		if (end.kind !== "finished" || end.result.kind !== "official") problems.push(`ended ${end.kind}${end.kind === "stopped" ? ` (${JSON.stringify(end.reason)})` : ""}`);
		if (board.violations.length > 0) problems.push(`violations ${JSON.stringify(board.violations.slice(0, 3))}${board.violations.length > 3 ? ` and ${board.violations.length - 3} more` : ""}`);
		if (boot.mode !== "app" || boot.versionPageSha256 !== image.entry.versionBlock.sha256) problems.push(`boots ${boot.mode} over ${boot.versionPageSha256}`);
		return { board, why: problems.join("; ") };
	};
	for (const start of starts) {
		for (const iap of iaps) {
			for (const rewrite of [false, true]) {
				// Every shard makes the clean run, which counts the packets; only the shard that owns it reports it.
				const clean = await run({}, start, iap, rewrite);
				if (inShard(total++, shard)) {
					runs++;
					if (clean.why !== "") failures.push({ start, iap, rewrite, packet: -1, lost: "before", resetOnLoss: false, why: `clean run: ${clean.why}` });
				}
				for (let packet = 0; packet < clean.board.packetsReceived; packet++) {
					for (const lost of ["before", "after"] as const) {
						for (const resetOnLoss of [false, true]) {
							if (!inShard(total++, shard)) continue;
							runs++;
							const drop = lost === "before" ? { loseLinkAtPacket: packet } : { loseLinkAfterPacket: packet };
							const { why } = await run({ ...drop, resetOnLoss }, start, iap, rewrite);
							if (why !== "") failures.push({ start, iap, rewrite, packet, lost, resetOnLoss, why });
						}
					}
				}
			}
		}
	}
	return { runs, total, failures };
}

if (import.meta.main) {
	const { syntheticFlashable } = await import("./synthetic-image");
	const started = performance.now();
	// `--shard=INDEX/COUNT` runs one slice of the run set (CI runs the slices in parallel); no flag runs all of it.
	const shardFlag = process.argv.slice(2).find((arg) => arg.startsWith("--shard="));
	const shard = shardFlag === undefined ? undefined : parseShard(shardFlag.slice("--shard=".length));
	const asked = process.argv.slice(2).filter((arg) => arg !== shardFlag);
	const unknown = asked.filter((name) => !(STARTS as readonly string[]).includes(name) && !(IAP_BEHAVIORS as readonly string[]).includes(name));
	if (unknown.length > 0) throw new Error(`unknown starts or erase behaviors: ${unknown.join(", ")}`);
	const pick = <T extends string>(all: readonly T[]) => (asked.some((name) => (all as readonly string[]).includes(name)) ? all.filter((name) => asked.includes(name)) : all);
	let report: { readonly runs: number; readonly total: number; readonly failures: number; readonly examples: readonly unknown[] };
	if (asked.length > 0) {
		const { runs, total, failures } = await dropSweep(await syntheticFlashable(), pick(STARTS), pick(IAP_BEHAVIORS), shard);
		report = { runs, total, failures: failures.length, examples: failures.slice(0, 5) };
	} else {
		// One process per start and erase behavior: the runs share nothing, and one process takes about 8 minutes.
		const parts = await Promise.all(
			STARTS.flatMap((start) =>
				IAP_BEHAVIORS.map(async (iap) => {
					const child = Bun.spawn([process.execPath, import.meta.path, start, iap, ...(shardFlag === undefined ? [] : [shardFlag])], { stdout: "pipe", stderr: "inherit" });
					const text = await new Response(child.stdout).text();
					await child.exited;
					return JSON.parse(text) as typeof report;
				}),
			),
		);
		report = { runs: parts.reduce((n, part) => n + part.runs, 0), total: parts.reduce((n, part) => n + part.total, 0), failures: parts.reduce((n, part) => n + part.failures, 0), examples: parts.flatMap((part) => part.examples).slice(0, 5) };
	}
	console.log(JSON.stringify({ ...(shard === undefined ? {} : { shard: `${shard.index}/${shard.count}` }), ...report, seconds: Math.round((performance.now() - started) / 100) / 10 }));
	process.exit(report.failures === 0 ? 0 : 1);
}
