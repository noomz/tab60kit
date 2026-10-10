import { type BootTarget, type ChipState, type Observed, bootTarget, leaveUpdateMode, observe } from "../core/chip";
import { EXPECTED_LAYOUT, TAB60 } from "../core/device";
import { CATALOG } from "../core/firmware";
import { PROBE_EVERY_MS, WRITE_LINK_RULE } from "../core/flash";
import type { JobContext } from "../core/job";
import {
	type AppRefused,
	type AppSession,
	IapAttachFailed,
	type IapRefused,
	type IapSession,
	type LinkContext,
	connect,
	labClearance,
} from "../core/protocol";
import type { U1Expected } from "./u1-checks";
import type { Phase, Run, RunOutcome } from "./u1-state";

export const U1_ROWS = ["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"] as const;
export const U1_PURPOSE = "U1: bootloader round trip and read-only deep check";

export const u1Clearance = () => labClearance(U1_ROWS, U1_PURPOSE);

export interface ProbeSeries {
	readonly probes: number;
	readonly everyMs: number;
}

export const U1_PROBES: ProbeSeries = { probes: 30, everyMs: PROBE_EVERY_MS };

const V1_01_13 = CATALOG.find((entry) => entry.version === "V1.01.13");
if (V1_01_13 === undefined) throw new Error("the catalog lost V1.01.13");

/** What the user's board, flashed with V1.01.13 by the vendor updater, must answer (docs/units.md U1 checks 2 to 7 and 9). */
export const U1_EXPECTED: U1Expected = {
	appProductId: TAB60.productId.app,
	iapProductId: TAB60.productId.iap,
	usagePage: TAB60.usagePage,
	usage: TAB60.usage,
	reportBytes: TAB60.reportBytes,
	identityHex: EXPECTED_LAYOUT.identityHex,
	fwOffset: EXPECTED_LAYOUT.fwOffset,
	pageSize: EXPECTED_LAYOUT.pageSize,
	fwPages: EXPECTED_LAYOUT.fwPages,
	versionPageSha256: V1_01_13.versionBlock.sha256,
	imageBytes: V1_01_13.image.bytes,
	imageSum32: V1_01_13.image.wireSum32,
	probes: U1_PROBES.probes,
	maxProbeGapMs: WRITE_LINK_RULE.maxProbeGapMs,
	probeSpacingMs: U1_PROBES.everyMs,
};

export interface U1Context extends LinkContext {
	readonly log: (line: string) => void;
	readonly series: ProbeSeries;
}

export type ConnectEnd = { readonly kind: "connected"; readonly session: AppSession; readonly observed: Observed } | { readonly kind: "refused"; readonly refused: AppRefused };

/** Where a restart into normal mode ended: the confirmed session, a refusal, or null when no device was picked. */
export type Back = AppSession | AppRefused | null;

export type DeepCheckEnd = { readonly kind: "done"; readonly bootTarget: BootTarget; readonly back: Back } | { readonly kind: "refused"; readonly refused: IapRefused };

const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, "0")}`;
const describe = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

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
		ctx.signal.throwIfAborted();
		await session.probe();
	}
	ctx.log(`${ctx.series.probes} READ MODE probes answered in ${session.mode === "app" ? "normal" : "update"} mode`);
}

async function withHome<T>(ctx: U1Context, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (error) {
		if (!(error instanceof IapAttachFailed)) throw error;
		ctx.log(`update-mode attach failed (${describe(error.cause)}), sending RESET to app`);
		await error.restartToApp().catch(() => undefined);
		await error.close();
		throw error.cause;
	}
}

export async function u1Connect(ctx: U1Context): Promise<ConnectEnd> {
	const session = await connect(ctx, { modes: ["app"], reason: "connect" });
	if ("refusal" in session) return { kind: "refused", refused: session };
	const observed = await observe(session);
	ctx.log(describeChip(observed.chip));
	await probeSeries(session, ctx);
	return { kind: "connected", session, observed };
}

const jobContext = (ctx: U1Context): JobContext => ({
	...ctx,
	progress: (activity) => ctx.log(`${activity.kind}${"into" in activity ? ` into ${activity.into === "app" ? "normal" : "update"} mode` : ""}`),
});

/** U1 is read-only and the board types, so it leaves update mode whatever the boot target says (decision 9). */
async function goHome(iap: IapSession | IapRefused, ctx: U1Context): Promise<Back> {
	const back = await leaveUpdateMode(iap, jobContext(ctx));
	ctx.log(back === null ? "confirm pick skipped" : "refusal" in back ? `normal mode refused: ${back.refusal.code}` : "back in normal mode");
	return back;
}

async function updateModeChecks(iap: IapSession, ctx: U1Context): Promise<BootTarget> {
	const observed = await observe(iap);
	ctx.log(describeChip(observed.chip));
	const boot = bootTarget(observed.chip);
	ctx.log(`boot target: ${boot}`);
	await probeSeries(iap, ctx);
	return boot;
}

/**
 * The update-mode checks, then home. A check that throws, a Cancel included, first sends RESET to app best effort,
 * and the link closes even when that send fails (F1). Then the error propagates.
 */
export async function u1UpdateModePhase(iap: IapSession, ctx: U1Context): Promise<DeepCheckEnd> {
	const boot = await updateModeChecks(iap, ctx).catch(async (error: unknown) => {
		ctx.log(`update-mode checks stopped (${describe(error)}), sending RESET to app`);
		await iap.exitToApp().catch(() => undefined);
		throw error;
	});
	return { kind: "done", bootTarget: boot, back: await goHome(iap, ctx) };
}

export async function u1DeepCheck(app: AppSession, ctx: U1Context): Promise<DeepCheckEnd> {
	const iap = await withHome(ctx, () => app.enterIap(ctx));
	if ("refusal" in iap) return { kind: "refused", refused: iap };
	return u1UpdateModePhase(iap, ctx);
}

export async function u1TryAgain(ctx: U1Context): Promise<DeepCheckEnd> {
	const iap = await withHome(ctx, () => connect(ctx, { modes: ["iap"], reason: "enter-update-mode" }));
	if ("refusal" in iap) return { kind: "refused", refused: iap };
	return u1UpdateModePhase(iap, ctx);
}

/** Connects in update mode, sends RESET to app through the session or the refusal, then runs the confirm pick. */
export async function u1Restart(ctx: U1Context): Promise<Back> {
	return goHome(await withHome(ctx, () => connect(ctx, { modes: ["iap"], reason: "enter-update-mode" })), ctx);
}

/** Restart into normal mode through a refusal the page still holds, so no pick is needed for the update-mode link. */
export function u1RestartHeld(refused: IapRefused, ctx: U1Context): Promise<Back> {
	return goHome(refused, ctx);
}

const backOutcome = (back: Back): RunOutcome => (back === null ? { kind: "none" } : "refusal" in back ? { kind: "refused", refused: back } : { kind: "connected", app: back });

function deepOutcome(end: DeepCheckEnd, ctx: U1Context): RunOutcome {
	if (end.kind === "done") return backOutcome(end.back);
	ctx.log(`update mode refused: ${end.refused.refusal.code}`);
	return { kind: "refused", refused: end.refused };
}

async function release(from: Phase): Promise<void> {
	if (from.kind === "connected") await from.app.close();
	if (from.kind === "refused") await from.refused.close();
	if (from.kind === "away" && from.holding !== null) await from.holding.close();
}

/**
 * What each of the page's buttons runs, from the phase it was clicked in. A run first closes the link the phase holds,
 * unless it uses that link: Deep check takes the session, and Restart takes a held refusal.
 */
export async function u1Run(what: Run, from: Phase, ctx: U1Context): Promise<RunOutcome> {
	switch (what) {
		case "connect": {
			await release(from);
			const end = await u1Connect(ctx);
			if (end.kind === "connected") return { kind: "connected", app: end.session };
			ctx.log(`normal mode refused: ${end.refused.refusal.code}`);
			return { kind: "refused", refused: end.refused };
		}
		case "deep-check":
			if (from.kind !== "connected") throw new Error("Deep check starts from a normal-mode session");
			return deepOutcome(await u1DeepCheck(from.app, ctx), ctx);
		case "try-again":
			await release(from);
			return deepOutcome(await u1TryAgain(ctx), ctx);
		case "restart": {
			if (from.kind === "away" && from.holding !== null) return backOutcome(await u1RestartHeld(from.holding, ctx));
			await release(from);
			return backOutcome(await u1Restart(ctx));
		}
		default: {
			const exhaustive: never = what;
			return exhaustive;
		}
	}
}
