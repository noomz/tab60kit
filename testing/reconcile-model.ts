/**
 * Candidate A's drop test (proof/reconcile.ts), adapted to this design's own decision code. It drives the real
 * decideInApp, decideInIap, STEPS, and MAX_LINK_LOSSES from core/flash.ts over a toy board (mode, image, version page:
 * no bytes, no addresses), through the loop that makeOfficial's TODO describes. Drops land at every combination of up
 * to four of the first 40 drop points, with and without an MCU reset on each drop, from nine starting states, on a
 * board whose image writes all verify and on one whose first two writes fail their checksum, which the vendor's
 * budget of three write attempts must still finish.
 *
 * Three loops run. "as received, descending erase" is candidate C before synthesis: a drop counts as a step attempt,
 * one ERASE clears the whole window, and no link gate runs; the IAP clears the window's pages from the top, an order
 * nothing rules out. "as received, ascending erase" is the same loop with the order C assumed, which isolates the
 * attempt-count defect. "synthesized" is this design: a drop resets the attempt counts, the version page is erased by
 * its own command first, the link gate probes before the first flash write on each link, and rewrite runs as a goal.
 *
 * The model checks the loop's logic against a model of the board. It cannot show that the board behaves like the
 * model; U1, U7, and U8 are where the two meet. The deep check writes nothing, so it is not modeled here.
 *
 * Run: bun testing/reconcile-model.ts   It throws when the synthesized loop has any problem.
 */
import type { AppChip, IapChip, ImageCheck, PageState } from "../core/chip";
import { EXPECTED_LAYOUT } from "../core/device";
import { CATALOG, type FlashableImage } from "../core/firmware";
import { MAX_LINK_LOSSES, STEPS, type Step, decideInApp, decideInIap } from "../core/flash";
import type { BlInfo, FlashWindow } from "../core/flashmap";
import { type Mode, sha256Literal, sum32Literal } from "../core/units";

type Contents = "target" | "other" | "erased" | "partial";
interface Board {
	mode: Mode;
	image: Contents;
	page: Contents;
}

const entry = CATALOG[0];
if (entry === undefined) throw new Error("the catalog is empty");
const target = { entry } as unknown as FlashableImage;
const window = { base: 0x3000, imageBase: 0x3200, end: 0x1fe00, pageSize: 0x200 } as unknown as FlashWindow;
const info: BlInfo = {
	bootVid: 0x04d9,
	bootPid: 0x1304,
	fwOffset: 0x200,
	fwPages: 0xe7,
	pageSize: 0x200,
	model: "",
	identityHex: EXPECTED_LAYOUT.identityHex,
	raw: new Uint8Array(52),
};
const unknownPage = (text: string | null): PageState => ({ kind: "unknown", text, sha256: sha256Literal("0".repeat(64)) });
const unrecognized: ImageCheck = { kind: "unrecognized", sum: sum32Literal(0), crc: null };
const PAGE: Record<Contents, PageState> = {
	target: { kind: "official", entry },
	other: unknownPage("V1.01.16"),
	erased: { kind: "erased" },
	partial: unknownPage(null),
};
const IMAGE: Record<Contents, ImageCheck> = {
	target: { kind: "official", entry, by: "sum" },
	other: unrecognized,
	erased: unrecognized,
	partial: unrecognized,
};
const appChip = (board: Board): AppChip => ({ mode: "app", info, window, page: PAGE[board.page] });
const iapChip = (board: Board): IapChip => ({ mode: "iap", info, window, page: PAGE[board.page], image: IMAGE[board.image] });

/** A page with the 0x5AA5 magic: the target's block, or another firmware's. A block cut short has none. */
const magic = (page: Contents) => page === "target" || page === "other";
const incomplete = (image: Contents) => image === "erased" || image === "partial";
/** The IAP's boot rule (R1, INFERRED): it runs the image only while the version page holds its magic. */
const bootsInto = (board: Board): Mode => (magic(board.page) ? "app" : "iap");

interface Loop {
	readonly name: string;
	readonly resetAttemptsOnLoss: boolean;
	readonly erase: "one-command-descending" | "one-command-ascending" | "page-first";
	readonly linkGate: boolean;
	readonly rewriteGoals: readonly boolean[];
}

const LOOPS: readonly Loop[] = [
	{ name: "as received, descending erase", resetAttemptsOnLoss: false, erase: "one-command-descending", linkGate: false, rewriteGoals: [false] },
	{ name: "as received, ascending erase", resetAttemptsOnLoss: false, erase: "one-command-ascending", linkGate: false, rewriteGoals: [false] },
	{ name: "synthesized", resetAttemptsOnLoss: true, erase: "page-first", linkGate: true, rewriteGoals: [false, true] },
];

const STARTS: Readonly<Record<string, Board>> = {
	"normal mode, V1.01.13": { mode: "app", image: "target", page: "target" },
	"normal mode, untrusted firmware": { mode: "app", image: "other", page: "other" },
	"normal mode, official page over other firmware": { mode: "app", image: "other", page: "target" },
	"update mode, all erased": { mode: "iap", image: "erased", page: "erased" },
	"update mode, image half written": { mode: "iap", image: "partial", page: "erased" },
	"update mode, image done, page erased": { mode: "iap", image: "target", page: "erased" },
	"update mode, page cut short": { mode: "iap", image: "target", page: "partial" },
	"update mode, V1.01.13": { mode: "iap", image: "target", page: "target" },
	"update mode, untrusted firmware": { mode: "iap", image: "other", page: "other" },
};

class Drop extends Error {}
const DROP = new Drop("link lost");

interface Run {
	readonly end: "finished" | "stopped" | "bricked";
	readonly why: string;
	readonly board: Board;
	readonly problems: ReadonlySet<string>;
	readonly wroteImage: boolean;
	readonly points: number;
}

function run(
	loop: Loop,
	start: Board,
	rewriteGoal: boolean,
	drops: readonly number[],
	resetOnLoss: boolean,
	failingWrites: number,
): Run {
	const board: Board = { ...start };
	const problems = new Set<string>();
	let point = 0;
	let nextDrop = 0;
	/** A place where the link can die. */
	const at = () => {
		if (nextDrop < drops.length && drops[nextDrop] === point) {
			nextDrop++;
			point++;
			throw DROP;
		}
		point++;
	};
	/** A change on the board, then the question an MCU reset would ask at this instant. */
	const set = (change: Partial<Board>) => {
		Object.assign(board, change);
		if (magic(board.page) && incomplete(board.image)) problems.add("a reset here would boot an incomplete image");
	};
	const end = (kind: Run["end"], why: string): Run => ({ end: kind, why, board, problems, wroteImage, points: point });

	const attempts = new Map<Step, number>();
	let losses = 0;
	let verified = false;
	let rewrite = rewriteGoal;
	let wroteImage = false;
	let link = 0;
	let open = false;
	let gatedLink = -1;
	let badWrites = failingWrites;

	for (let turn = 0; turn < 500; turn++) {
		try {
			if (!open) {
				at();
				link++;
				open = true;
			}
			at();
			const step: Step =
				board.mode === "app" ? decideInApp(appChip(board), target, verified) : decideInIap(iapChip(board), target, rewrite);
			if (step === "done") return end("finished", "done");
			const attempt = (attempts.get(step) ?? 0) + 1;
			attempts.set(step, attempt);
			if (attempt > STEPS[step].maxAttempts) return end("stopped", `attempts-exhausted at ${step}`);
			if (loop.linkGate && STEPS[step].changesFlash && gatedLink !== link) {
				at();
				at();
				gatedLink = link;
			}
			switch (step) {
				case "enter-iap":
					at();
					set({ mode: "iap" });
					open = false;
					at();
					link++;
					open = true;
					break;
				case "erase-and-write-image":
					if (board.mode !== "iap") throw new Error("erase in normal mode");
					if (loop.erase === "page-first") {
						at();
						set({ page: "erased" });
						at();
						set({ image: "partial" });
						at();
						set({ image: "erased" });
						at();
					} else if (loop.erase === "one-command-ascending") {
						at();
						set({ page: "erased" });
						set({ image: "partial" });
						at();
						set({ image: "erased" });
						at();
					} else {
						at();
						set({ image: "partial" });
						at();
						set({ image: "erased" });
						at();
						set({ page: "erased" });
						at();
					}
					at();
					set({ image: "partial" });
					at();
					at();
					set({ image: badWrites > 0 ? "other" : "target" });
					badWrites = Math.max(0, badWrites - 1);
					at();
					rewrite = false;
					wroteImage = true;
					break;
				case "write-version-block":
					if (board.image !== "target") problems.add("version block written over an image that is not the target");
					at();
					set({ page: "partial" });
					at();
					at();
					set({ page: "target" });
					at();
					break;
				case "exit-to-app":
					verified = true;
					at();
					set({ mode: bootsInto(board) });
					open = false;
					at();
					link++;
					open = true;
					break;
				default: {
					const exhaustive: never = step;
					throw new Error(`unhandled step ${String(exhaustive)}`);
				}
			}
		} catch (error) {
			if (!(error instanceof Drop)) throw error;
			open = false;
			if (resetOnLoss) {
				const mode = bootsInto(board);
				if (mode === "app" && incomplete(board.image)) {
					problems.add("an MCU reset booted an incomplete image");
					return end("bricked", "booted an incomplete image");
				}
				board.mode = mode;
			}
			if (loop.resetAttemptsOnLoss) attempts.clear();
			if (++losses > MAX_LINK_LOSSES) return end("stopped", "too-many-link-losses");
		}
	}
	return end("stopped", "no end after 500 turns");
}

const POINTS = 40;
const MAX_DROPS = 4;
function combinations(n: number, k: number, from = 0): number[][] {
	if (k === 0) return [[]];
	const out: number[][] = [];
	for (let i = from; i < n; i++) for (const rest of combinations(n, k - 1, i + 1)) out.push([i, ...rest]);
	return out;
}
const PLANS: readonly (readonly number[])[] = Array.from({ length: MAX_DROPS + 1 }, (_, k) => combinations(POINTS, k)).flat();

const results: { readonly loop: string; readonly problems: number }[] = [];
for (const loop of LOOPS) {
	let runs = 0;
	let problemRuns = 0;
	let cleanPoints = 0;
	const kinds = new Map<string, number>();
	const examples: string[] = [];
	for (const [startName, start] of Object.entries(STARTS)) {
		for (const rewriteGoal of loop.rewriteGoals) {
			for (const resetOnLoss of [false, true]) {
				for (const failingWrites of [0, 2]) {
				for (const drops of PLANS) {
					runs++;
					const result = run(loop, start, rewriteGoal, drops, resetOnLoss, failingWrites);
					if (drops.length === 0 && failingWrites === 0) cleanPoints = Math.max(cleanPoints, result.points);
					const problems = [...result.problems];
					if (result.end === "finished") {
						const { mode, image, page } = result.board;
						if (mode !== "app" || image !== "target" || page !== "target") problems.push("finished away from the goal");
						if (rewriteGoal && !result.wroteImage) problems.push("a rewrite finished without writing the image");
					}
					if (result.end === "stopped") problems.push(`stopped within the loss budget: ${result.why.replace(/ at .*/, "")}`);
					if (problems.length === 0) continue;
					problemRuns++;
					for (const kind of problems) kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
					if (examples.length < 3) {
						examples.push(
							`${startName}, rewrite=${rewriteGoal}, reset on loss=${resetOnLoss}, failing writes=${failingWrites}, drops at [${drops.join(",")}]: ${result.end} (${result.why}); ${problems.join("; ")}`,
						);
					}
				}
				}
			}
		}
	}
	results.push({ loop: loop.name, problems: problemRuns });
	console.log(
		JSON.stringify({
			loop: loop.name,
			runs,
			problemRuns,
			problemKinds: Object.fromEntries(kinds),
			cleanRunDropPoints: cleanPoints,
			examples,
		}),
	);
}

const synthesized = results.find((result) => result.loop === "synthesized");
if (synthesized === undefined || synthesized.problems > 0) throw new Error(`the synthesized loop has ${synthesized?.problems} problem runs`);
