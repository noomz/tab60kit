/**
 * Plan unit U1's job, with no DOM, so the page and the end-to-end test drive the same code. Connect is a normal-mode
 * session, an observation, and the probe series. Deep check restarts into update mode, observes (version page and
 * SUM), runs the probe series, and leaves update mode whatever the boot target says: the unit is read-only and the
 * user needs the keyboard back. The lab reuses observe and leaveUpdateMode from core/chip.ts, so U6's deep check
 * sends this sequence by construction.
 */
import { type ChipState, type Observed, bootTarget, leaveUpdateMode, observe } from "../core/chip";
import { PROBE_EVERY_MS } from "../core/flash";
import type { JobContext } from "../core/job";
import {
	type AppRefused,
	type AppSession,
	type IapRefused,
	type IapSession,
	type LinkContext,
	connect,
	labClearance,
} from "../core/protocol";

export const U1_ROWS = ["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"] as const;
export const U1_PURPOSE = "U1: bootloader round trip and read-only deep check";

/** Throws until the seven rows are reviewed, so a page built from an unreviewed tree refuses to start. */
export const u1Clearance = () => labClearance(U1_ROWS, U1_PURPOSE);

export interface ProbeSeries {
	readonly probes: number;
	readonly everyMs: number;
}

/** Plan check 9: thirty READ MODE probes at the link gate's spacing, in each mode. */
export const U1_PROBES: ProbeSeries = { probes: 30, everyMs: PROBE_EVERY_MS };

export interface U1Context extends LinkContext {
	readonly log: (line: string) => void;
	readonly series: ProbeSeries;
}

export type ConnectEnd = { readonly kind: "connected"; readonly session: AppSession; readonly observed: Observed } | { readonly kind: "refused"; readonly refused: AppRefused };

export type DeepCheckEnd =
	| { readonly kind: "done"; readonly bootTarget: ReturnType<typeof bootTarget>; readonly back: AppSession | AppRefused | null }
	| { readonly kind: "refused"; readonly refused: IapRefused };

const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, "0")}`;

export function describeChip(chip: ChipState): string {
	const page =
		chip.page.kind === "official"
			? `official ${chip.page.entry.version}`
			: chip.page.kind === "erased"
				? "erased"
				: `unknown (${chip.page.text ?? "no version text"}, sha256 ${chip.page.sha256.slice(0, 12)})`;
	const image =
		chip.mode === "iap"
			? chip.image.kind === "official"
				? `, image official ${chip.image.entry.version} by ${chip.image.by}`
				: `, image unrecognized (sum ${hex(chip.image.sum, 8)})`
			: "";
	return `${chip.mode === "app" ? "normal" : "update"} mode: BL info ${chip.info.model} identity ${chip.info.identityHex}, page ${page}${image}`;
}

async function probeSeries(session: AppSession | IapSession, ctx: U1Context): Promise<void> {
	for (let i = 0; i < ctx.series.probes; i++) {
		if (i > 0) await ctx.port.clock.sleep(ctx.series.everyMs, ctx.signal);
		await session.probe();
	}
	ctx.log(`${ctx.series.probes} READ MODE probes answered in ${session.mode === "app" ? "normal" : "update"} mode`);
}

/** Connect: a normal-mode session, an observation, and the probe series (plan checks 3, 4, 6, and 9). */
export async function u1Connect(ctx: U1Context): Promise<ConnectEnd> {
	const session = await connect(ctx, { modes: ["app"], reason: "connect" });
	if ("refusal" in session) return { kind: "refused", refused: session };
	const observed = await observe(session);
	ctx.log(describeChip(observed.chip));
	await probeSeries(session, ctx);
	return { kind: "connected", session, observed };
}

/** The update-mode half of the deep check, from an attached bootloader session: also the resume point for Try again. */
export async function u1UpdateModePhase(iap: IapSession, ctx: U1Context): Promise<DeepCheckEnd> {
	const observed = await observe(iap);
	ctx.log(describeChip(observed.chip));
	const boot = bootTarget(observed.chip);
	ctx.log(`boot target: ${boot}`);
	await probeSeries(iap, ctx);
	const jobContext: JobContext = { ...ctx, progress: (activity) => ctx.log(`${activity.kind}${"into" in activity ? ` into ${activity.into === "app" ? "normal" : "update"} mode` : ""}`) };
	const back = await leaveUpdateMode(iap, jobContext);
	ctx.log(back === null ? "confirm pick skipped" : "refusal" in back ? `normal mode refused: ${back.refusal.code}` : "back in normal mode");
	return { kind: "done", bootTarget: boot, back };
}

/** Deep check: into update mode inside the click's activation, then the update-mode phase (plan checks 1, 2, 5, 7, 8, 9). */
export async function u1DeepCheck(app: AppSession, ctx: U1Context): Promise<DeepCheckEnd> {
	const iap = await app.enterIap(ctx);
	if ("refusal" in iap) return { kind: "refused", refused: iap };
	return u1UpdateModePhase(iap, ctx);
}

/** Try again after no answer in update mode: the granted bootloader device is reused, then the phase resumes. */
export async function u1TryAgain(ctx: U1Context): Promise<DeepCheckEnd> {
	const iap = await connect(ctx, { modes: ["iap"], reason: "enter-update-mode" });
	if ("refusal" in iap) return { kind: "refused", refused: iap };
	return u1UpdateModePhase(iap, ctx);
}
