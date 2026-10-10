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
import { CATALOG, type CatalogEntry, sha256 } from "./firmware";
import type { BlInfo, FlashWindow, RegionName } from "./flashmap";
import type { Job, JobContext } from "./job";
import { PickCancelled } from "./port";
import { type AppRefused, type AppSession, type IapSession, type Session, type VersionPageRead, connect } from "./protocol";
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
 * Reads the chip through an open session: the version page in either mode, plus the image checksum in update mode,
 * one SUM (and CRC once cleared) per distinct catalog image length. With no match, the first length's result is
 * reported as unrecognized.
 */
export async function observe(session: Session): Promise<Observed> {
	const page = await classifyPage(await session.readVersionPage());
	const { info, window } = session;
	if (session.mode === "app") return { mode: "app", session, chip: { mode: "app", info, window, page } };
	const image = await checkImage(session);
	return { mode: "iap", session, chip: { mode: "iap", info, window, page, image } };
}

async function checkImage(session: IapSession): Promise<ImageCheck> {
	const lengths = [...new Set(CATALOG.map((entry) => entry.image.bytes))];
	let first: ImageCheck | null = null;
	for (const bytes of lengths) {
		const { sum, crc } = await session.checksum(bytes);
		const entry = CATALOG.find((candidate) => candidate.image.bytes === bytes && candidate.image.wireSum32 === sum && (crc === null || candidate.image.wireCrc32 === crc));
		if (entry !== undefined) return { kind: "official", entry, by: crc === null ? "sum" : "sum-and-crc" };
		first ??= { kind: "unrecognized", sum, crc };
	}
	if (first === null) throw new Error("the catalog is empty");
	return first;
}

/** The version string's byte length at offset 0 may reach offset 0x78, where the fixed words start (R1 "Version page"). */
const VERSION_TEXT_MAX_BYTES = 0x78 - 4;

/**
 * Erased when every byte is 0xFF, official when the bytes hash to a catalog version block, unknown otherwise, with
 * the UTF-16LE string at offset 4 when the length word at offset 0 fits before the fixed words.
 */
export async function classifyPage(page: VersionPageRead): Promise<PageState> {
	const { bytes } = page;
	if (bytes.every((b) => b === 0xff)) return { kind: "erased" };
	const digest = await sha256(bytes);
	const entry = CATALOG.find((candidate) => candidate.versionBlock.sha256 === digest);
	if (entry !== undefined) return { kind: "official", entry };
	return { kind: "unknown", text: versionText(bytes), sha256: digest };
}

function versionText(bytes: Uint8Array): string | null {
	const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
	if (length === 0 || length > VERSION_TEXT_MAX_BYTES) return null;
	const text = new TextDecoder("utf-16le").decode(bytes.subarray(4, 4 + length));
	const end = text.indexOf("\0");
	return end === -1 ? text : text.slice(0, end);
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
 * A cancel or a closed chooser there returns null, and the job still finishes (the UI calls this Skip).
 */
export async function leaveUpdateMode(iap: IapSession, ctx: JobContext): Promise<AppSession | AppRefused | null> {
	ctx.progress({ kind: "restarting", into: "app" });
	await iap.exitToApp();
	try {
		return await connect(ctx, { modes: ["app"], reason: "confirm-normal-mode" });
	} catch (error) {
		if (error instanceof PickCancelled || ctx.signal.aborted) return null;
		throw error;
	}
}
