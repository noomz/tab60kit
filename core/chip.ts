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
import { MAX_LINK_LOSSES } from "./flash";
import { type BlInfo, type FlashWindow, type RegionName, regions } from "./flashmap";
import { type Activity, type Job, type JobContext, type JobEnd, type StopReason, isLinkFailure, stopReasonFor } from "./job";
import { PickCancelled } from "./port";
import { type AppRefused, type AppSession, DeviceRefused, IapAttachFailed, type IapRefused, type IapSession, ModeDisagrees, type Session, type VersionPageRead, connect } from "./protocol";
import type { Crc32, Sha256, Sum32 } from "./units";

export type PageState =
	| { readonly kind: "erased" }
	| { readonly kind: "official"; readonly entry: CatalogEntry }
	/**
	 * Anything else, including a block cut short by a lost link. `text` is the version string when it decodes. `boots`
	 * says whether the IAP would boot the app over it: the 0x5AA5 magic and a programmed word at 0x78 (R1, INFERRED).
	 */
	| { readonly kind: "unknown"; readonly text: string | null; readonly sha256: Sha256; readonly boots: boolean };

export type ImageCheck =
	| { readonly kind: "official"; readonly entry: CatalogEntry; readonly by: "sum" | "sum-and-crc" }
	| { readonly kind: "unrecognized"; readonly sum: Sum32; readonly crc: Crc32 | null };

export interface AppChip {
	readonly mode: "app";
	readonly info: BlInfo;
	/** SHA-256 of `info.raw`, the bootloader's fingerprint in the report. */
	readonly blInfoSha256: Sha256;
	readonly window: FlashWindow;
	readonly page: PageState;
}

/** Only update mode can checksum the image, so only this variant has `image`. */
export interface IapChip {
	readonly mode: "iap";
	readonly info: BlInfo;
	readonly blInfoSha256: Sha256;
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
 * Rejects with the signal's reason, before its next command leaves, once `signal` is aborted. `catalog` is CATALOG
 * except in the flash job, which also recognizes the entry it was asked to write (flash.ts).
 */
export async function observe(session: Session, signal: AbortSignal, catalog: readonly CatalogEntry[] = CATALOG): Promise<Observed> {
	const page = await classifyPage(await session.readVersionPage(signal), catalog);
	const { info, window } = session;
	const blInfoSha256 = await sha256(info.raw);
	if (session.mode === "app") return { mode: "app", session, chip: { mode: "app", info, blInfoSha256, window, page } };
	const image = await checkImage(session, signal, catalog);
	return { mode: "iap", session, chip: { mode: "iap", info, blInfoSha256, window, page, image } };
}

async function checkImage(session: IapSession, signal: AbortSignal, catalog: readonly CatalogEntry[]): Promise<ImageCheck> {
	const lengths = [...new Set(catalog.map((entry) => entry.image.bytes))];
	let first: ImageCheck | null = null;
	for (const bytes of lengths) {
		const { sum, crc } = await session.checksum(bytes, signal);
		const entry = catalog.find((candidate) => candidate.image.bytes === bytes && candidate.image.wireSum32 === sum && (crc === null || candidate.image.wireCrc32 === crc));
		if (entry !== undefined) return { kind: "official", entry, by: crc === null ? "sum" : "sum-and-crc" };
		first ??= { kind: "unrecognized", sum, crc };
	}
	if (first === null) throw new Error("the catalog is empty");
	return first;
}

/** The version page (R1): a u32 byte length, the UTF-16LE version string, then fixed words from 0x78. */
const VERSION_TEXT_OFFSET = 4;
const FIXED_WORDS_OFFSET = 0x78;

export async function classifyPage(page: VersionPageRead, catalog: readonly CatalogEntry[] = CATALOG): Promise<PageState> {
	const { bytes } = page;
	if (bytes.every((b) => b === 0xff)) return { kind: "erased" };
	const digest = await sha256(bytes);
	const entry = catalog.find((candidate) => candidate.versionBlock.sha256 === digest);
	if (entry !== undefined) return { kind: "official", entry };
	return { kind: "unknown", text: versionText(bytes), sha256: digest, boots: bootable(bytes) };
}

const MAGIC_OFFSET = 0xb0;
const MAGIC = 0x5aa5;

function bootable(bytes: Uint8Array): boolean {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getUint16(MAGIC_OFFSET, true) === MAGIC && view.getUint32(FIXED_WORDS_OFFSET, true) !== 0xffffffff;
}

function versionText(bytes: Uint8Array): string | null {
	const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
	if (length === 0 || length > FIXED_WORDS_OFFSET - VERSION_TEXT_OFFSET) return null;
	const text = new TextDecoder("utf-16le").decode(bytes.subarray(VERSION_TEXT_OFFSET, VERSION_TEXT_OFFSET + length));
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
	if (chip.page.kind === "erased" || (chip.page.kind === "unknown" && !chip.page.boots)) return "stays-in-update-mode";
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

const hex32 = (n: number) => `0x${n.toString(16).padStart(8, "0")}`;

function pageFinding(page: PageState): Finding {
	if (page.kind === "official") return { kind: "official", entry: page.entry, by: "version-page-bytes" };
	if (page.kind === "erased") return { kind: "erased" };
	return { kind: "unrecognized", detail: `${page.text === null ? "no version text" : `"${page.text}"`}, sha256 ${page.sha256}` };
}

/** The flash map the Check screen draws. Pure. Rows follow the table at the top of this file. */
export function report(chip: ChipState): ChipReport {
	const rows: ChipReport["regions"][number][] = [];
	for (const { name, from, to } of regions(chip.window)) {
		switch (name) {
			case "bootloader":
				rows.push({ region: name, from, to, finding: { kind: "not-checkable-over-usb", why: "only the 52-byte BL info window is readable", fingerprint: chip.blInfoSha256 } });
				break;
			case "version-page":
				rows.push({ region: name, from, to, finding: pageFinding(chip.page) });
				break;
			case "app":
				if (chip.mode === "app") rows.push({ region: name, from, to, finding: { kind: "needs-deep-check" } });
				else if (chip.image.kind === "official") {
					const end = from + chip.image.entry.image.bytes;
					rows.push({ region: name, from, to: end, finding: { kind: "official", entry: chip.image.entry, by: chip.image.by } });
					rows.push({ region: name, from: end, to, finding: { kind: "not-checked", why: "the key alignment of a checksum that starts past the image is unknown" } });
				} else {
					const { sum, crc } = chip.image;
					rows.push({ region: name, from, to, finding: { kind: "unrecognized", detail: `sum ${hex32(sum)}${crc === null ? "" : `, CRC-32 ${hex32(crc)}`} matches no catalog image` } });
				}
				break;
			case "option-bytes":
				rows.push({ region: name, from, to, finding: { kind: "not-checkable-over-usb", why: "no command reads the option bytes", fingerprint: null } });
				break;
			default: {
				const exhaustive: never = name;
				return exhaustive;
			}
		}
	}
	return { regions: rows, boot: bootTarget(chip) };
}

/** Connect, or reuse the open session, and observe. Read-only. */
export const quickCheck: Job = (start, ctx) => check("quick", start, ctx);

/**
 * Enter update mode, checksum the image, and come back. Read-only, so a lost link restarts it from the top, and no
 * link gate applies. A board whose boot target is "boots-damaged-image" or "stays-in-update-mode" stays in update
 * mode: the report says a flash is needed before it can type.
 */
export const deepCheck: Job = (start, ctx) => check("deep", start, ctx);

/**
 * Both checks, as one loop. A refused board is never restarted, except to undo the deep check's own restart into
 * update mode. The deep check sends a board in update mode home only when its boot target says the IAP would boot it
 * anyway ("normal-mode" or "boots-unchecked-image"), so the restart does what a power cycle would do.
 */
async function check(depth: "quick" | "deep", start: Session | null, ctx: JobContext): Promise<JobEnd> {
	let session: Session | null = start;
	let board: ChipState | null = null;
	let during: Activity | null = null;
	let losses = 0;
	const progress = (activity: Activity, chip?: ChipState) => {
		during = activity;
		if (chip !== undefined) board = chip;
		if (chip === undefined) ctx.progress(activity);
		else ctx.progress(activity, chip);
	};
	const stopped = (reason: StopReason, end: Session | null = null): JobEnd => ({ kind: "stopped", reason, session: end, board });
	for (;;) {
		let restarted = false;
		try {
			if (session === null) {
				progress({ kind: "reading" });
				const opened = await connect(ctx, { modes: ["app", "iap"], reason: losses > 0 ? "after-link-loss" : "connect" });
				if ("refusal" in opened) {
					await opened.close();
					return stopped({ kind: "board-refused", refusal: opened.refusal });
				}
				session = opened;
			}
			let obs = await observe(session, ctx.signal);
			progress({ kind: "reading" }, obs.chip);
			if (depth === "quick") return { kind: "finished", result: { kind: "checked", depth }, session: obs.session, board };
			if (obs.mode === "app") {
				progress({ kind: "restarting", into: "iap" });
				const app = obs.session;
				session = null;
				restarted = true;
				const iap = await app.enterIap(ctx);
				if ("refusal" in iap) return stopped({ kind: "board-refused", refusal: iap.refusal }, await home(await leaveUpdateMode(iap, ctx)));
				session = iap;
				obs = await observe(iap, ctx.signal);
				progress({ kind: "reading" }, obs.chip);
			}
			if (obs.mode === "app") throw new Error("observe returned a normal-mode chip for an update-mode session");
			const boot = bootTarget(obs.chip);
			if (boot === "boots-damaged-image" || boot === "stays-in-update-mode") return { kind: "finished", result: { kind: "checked", depth }, session: obs.session, board };
			session = null;
			const back = await leaveUpdateMode(obs.session, ctx);
			if (back !== null && "refusal" in back) {
				await back.close();
				return stopped({ kind: "board-refused", refusal: back.refusal });
			}
			return { kind: "finished", result: { kind: "checked", depth }, session: back, board };
		} catch (error) {
			const cause = await releaseAfter(error, session, restarted);
			session = null;
			if (isLinkFailure(cause) || cause instanceof DeviceRefused || cause instanceof ModeDisagrees) {
				if (++losses > MAX_LINK_LOSSES) return stopped({ kind: "too-many-link-losses", losses });
				progress({ kind: "link-lost", losses });
				continue;
			}
			const reason = stopReasonFor(cause, ctx.signal, during);
			if (reason === null) throw cause;
			return stopped(reason);
		}
	}
}

/** The session a restart into normal mode hands back to the kit. A refusal there holds nothing worth keeping. */
export async function home(back: AppSession | AppRefused | null): Promise<AppSession | null> {
	if (back === null || !("refusal" in back)) return back;
	await back.close();
	return null;
}

/**
 * Lets go of whatever link the failed step held and returns the error to classify. A failed update-mode attach holds
 * its link open: it is restarted when this job put the board in update mode, and closed otherwise.
 */
async function releaseAfter(error: unknown, session: Session | null, restarted: boolean): Promise<unknown> {
	if (error instanceof IapAttachFailed) {
		await (restarted ? error.restartToApp() : error.close()).catch(() => undefined);
		return error.cause;
	}
	await session?.close().catch(() => undefined);
	return error;
}

/**
 * Shared by the deep check and the flash job. Restarts into normal mode, through the session or a refused board's own
 * RESET to app, then offers the optional confirm pick. The pick runs even when the restart's send failed, because the
 * board may have taken the frame. When the pick then finds no device, the restart's error propagates, because nothing
 * shows where the board is.
 */
export async function leaveUpdateMode(iap: IapSession | IapRefused, ctx: JobContext): Promise<AppSession | AppRefused | null> {
	ctx.progress({ kind: "restarting", into: "app" });
	const restart = await ("refusal" in iap ? iap.restartToApp() : iap.exitToApp()).then(
		() => null,
		(error: unknown) => ({ error }),
	);
	let back: AppSession | AppRefused | null;
	try {
		back = await connect(ctx, { modes: ["app"], reason: "confirm-normal-mode" });
	} catch (error) {
		if (!(error instanceof PickCancelled || ctx.signal.aborted)) throw error;
		back = null;
	}
	if (back === null && restart !== null) throw restart.error;
	return back;
}
