/**
 * What is on the chip, as the board itself reports it. This is the verify job, and it is also the flash job's
 * only record of progress: flash.ts decides every step from a fresh observation.
 *
 * What USB can and cannot check (R1, R4):
 *   bootloader [0x0, 0x3000)        not checkable. Only the 52-byte BL info window is readable; it is fingerprinted.
 *   version page [0x3000, 0x3200)   read exactly (180 bytes) in either mode, compared with catalog hashes.
 *   image [0x3200, +image length)   SUM (and CRC-32 once cleared under G1) in update mode, compared with the catalog.
 *   rest of the app region          not checked. The key alignment of a checksum that starts past the image is unknown.
 *   option bytes [0x1FE00, 0x20000) not checkable.
 */
import { CATALOG, type CatalogEntry } from "./firmware";
import type { BlInfo, FlashWindow, RegionName } from "./flashmap";
import type { Job, JobContext } from "./job";
import type { AppSession, IapSession, Session, VersionPageRead } from "./protocol";
import { type Crc32, type Sha256, type Sum32, notImplemented } from "./units";

export type PageState =
	| { readonly kind: "erased" }
	| { readonly kind: "official"; readonly entry: CatalogEntry }
	/** Anything else, including a block cut short by a lost link. `text` is the version string when it decodes. */
	| { readonly kind: "unknown"; readonly text: string | null; readonly sha256: Sha256 };

export type ImageCheck =
	| { readonly kind: "official"; readonly entry: CatalogEntry; readonly by: "sum" | "sum-and-crc" }
	| { readonly kind: "unrecognized"; readonly sum: Sum32; readonly crc: Crc32 | null };

export interface AppChip {
	readonly mode: "app";
	readonly info: BlInfo;
	readonly window: FlashWindow;
	readonly page: PageState;
}

/** Only update mode can checksum the image, so only this variant has `image`. */
export interface IapChip {
	readonly mode: "iap";
	readonly info: BlInfo;
	readonly window: FlashWindow;
	readonly page: PageState;
	readonly image: ImageCheck;
}

export type ChipState = AppChip | IapChip;

/** A session and what it observed, paired, so a step meant for one mode cannot run on the other mode's session. */
export type Observed =
	| { readonly mode: "app"; readonly session: AppSession; readonly chip: AppChip }
	| { readonly mode: "iap"; readonly session: IapSession; readonly chip: IapChip };

/**
 * Reads the chip through an open session.
 * TODO:
 *   page = classifyPage(await session.readVersionPage())
 *   app: return { mode, session, chip: { mode, info, window, page } }
 *   (readVersionPage sends parts 0, 1, and 2 of READ VERSION PAGE: sub 0x20, 0x21, 0x22)
 *   iap: for each distinct catalog image length L:
 *          { sum, crc } = await session.checksum(L)
 *          match = CATALOG entry with length L and wireSum32 == sum and (crc == null or wireCrc32 == crc)
 *        image = match ? official(match, crc ? "sum-and-crc" : "sum") : unrecognized(sum of the target length, crc)
 */
export async function observe(session: Session): Promise<Observed> {
	return notImplemented(`observe(${session.mode}) against ${CATALOG.length} catalog entries`);
}

/**
 * TODO: all 0xFF -> erased. sha256(bytes) equals a CATALOG versionBlock.sha256 -> official. Otherwise unknown,
 * with the UTF-16LE string at offset 4 when the length word at offset 0 is at most 116.
 */
export async function classifyPage(page: VersionPageRead): Promise<PageState> {
	return notImplemented(`classifyPage(${page.bytes.length})`);
}

/**
 * Where the board goes on its next reset, as far as the observation shows.
 * The IAP stays in update mode while the version page lacks its magic (INFERRED, R1). An official page over an
 * unrecognized image is the dangerous case: the IAP would jump into an image that failed its checksum.
 */
export type BootTarget = "normal-mode" | "stays-in-update-mode" | "boots-unchecked-image" | "boots-damaged-image";

export function bootTarget(chip: ChipState): BootTarget {
	if (chip.page.kind === "erased") return "stays-in-update-mode";
	if (chip.mode === "app") return chip.page.kind === "official" ? "normal-mode" : "boots-unchecked-image";
	if (chip.page.kind === "official") {
		return chip.image.kind === "official" && chip.image.entry.id === chip.page.entry.id
			? "normal-mode"
			: "boots-damaged-image";
	}
	return "boots-unchecked-image";
}

export type Finding =
	| { readonly kind: "not-checkable-over-usb"; readonly why: string; readonly fingerprint: Sha256 | null }
	| { readonly kind: "official"; readonly entry: CatalogEntry; readonly by: "version-page-bytes" | "sum" | "sum-and-crc" }
	| { readonly kind: "erased" }
	| { readonly kind: "unrecognized"; readonly detail: string }
	| { readonly kind: "needs-deep-check" }
	| { readonly kind: "not-checked"; readonly why: string };

export interface ChipReport {
	readonly regions: readonly { readonly region: RegionName; readonly from: number; readonly to: number; readonly finding: Finding }[];
	readonly boot: BootTarget;
}

/**
 * The flash map the Check screen draws. Pure.
 * TODO: regions(chip.window) mapped to findings per the table at the top of this file; the bootloader row carries
 * the sha256 of chip.info.raw as its fingerprint; boot = bootTarget(chip).
 */
export function report(chip: ChipState): ChipReport {
	return notImplemented(`report(${chip.mode})`);
}

/**
 * Connect, or reuse the open session, and observe. Read-only.
 * TODO: session = start ?? connect(ctx, { modes: ["app", "iap"], reason: "connect" }). Both modes, because a board
 * left in update mode by an interrupted flash must show up here and offer to finish it. Observe, finish.
 */
export const quickCheck: Job = async (start, ctx) => {
	return notImplemented(`quickCheck(${String(start?.mode)}, aborted=${ctx.signal.aborted})`);
};

/**
 * Enter update mode, checksum the image, and come back. Read-only, so a lost link restarts it from the top, and no
 * link gate applies.
 * TODO:
 *   obs = observe(start ?? connect(ctx, both modes))
 *   if app: session = obs.session.enterIap(ctx); obs = observe(session)
 *   if bootTarget(obs.chip) is "normal-mode" or "boots-unchecked-image": leaveUpdateMode(session, ctx)
 *   otherwise stay in update mode and finish: the report says a flash is needed before the board can type
 */
export const deepCheck: Job = async (start, ctx) => {
	return notImplemented(`deepCheck(${String(start?.mode)}, aborted=${ctx.signal.aborted})`);
};

/**
 * Shared by the deep check and the flash job: restart into normal mode, then offer the optional confirm pick.
 * TODO: progress(restarting app); await iap.exitToApp();
 *   try connect(ctx, { modes: ["app"], reason: "confirm-normal-mode" }) -> the app session
 *   a cancel or PickCancelled here -> null (the job still finishes; the UI calls this Skip)
 */
export async function leaveUpdateMode(iap: IapSession, ctx: JobContext): Promise<AppSession | null> {
	return notImplemented(`leaveUpdateMode(${iap.mode}, aborted=${ctx.signal.aborted})`);
}
