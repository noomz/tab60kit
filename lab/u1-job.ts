import { type ChipState, type Observed, bootTarget, leaveUpdateMode, observe } from "../core/chip";
import { EXPECTED_LAYOUT, TAB60 } from "../core/device";
import { CATALOG } from "../core/firmware";
import { PROBE_EVERY_MS, WRITE_LINK_RULE } from "../core/flash";
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
import type { U1Expected } from "./u1-checks";

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
};

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

export async function u1Connect(ctx: U1Context): Promise<ConnectEnd> {
	const session = await connect(ctx, { modes: ["app"], reason: "connect" });
	if ("refusal" in session) return { kind: "refused", refused: session };
	const observed = await observe(session);
	ctx.log(describeChip(observed.chip));
	await probeSeries(session, ctx);
	return { kind: "connected", session, observed };
}

export async function u1UpdateModePhase(iap: IapSession, ctx: U1Context): Promise<DeepCheckEnd> {
	const observed = await observe(iap);
	ctx.log(describeChip(observed.chip));
	const boot = bootTarget(observed.chip);
	ctx.log(`boot target: ${boot}`);
	await probeSeries(iap, ctx);
	// Decision 9: this unit is read-only and the board types, so leave update mode whatever the boot target says.
	const jobContext: JobContext = { ...ctx, progress: (activity) => ctx.log(`${activity.kind}${"into" in activity ? ` into ${activity.into === "app" ? "normal" : "update"} mode` : ""}`) };
	const back = await leaveUpdateMode(iap, jobContext);
	ctx.log(back === null ? "confirm pick skipped" : "refusal" in back ? `normal mode refused: ${back.refusal.code}` : "back in normal mode");
	return { kind: "done", bootTarget: boot, back };
}

export async function u1DeepCheck(app: AppSession, ctx: U1Context): Promise<DeepCheckEnd> {
	const iap = await app.enterIap(ctx);
	if ("refusal" in iap) return { kind: "refused", refused: iap };
	return u1UpdateModePhase(iap, ctx);
}

export async function u1TryAgain(ctx: U1Context): Promise<DeepCheckEnd> {
	const iap = await connect(ctx, { modes: ["iap"], reason: "enter-update-mode" });
	if ("refusal" in iap) return { kind: "refused", refused: iap };
	return u1UpdateModePhase(iap, ctx);
}
