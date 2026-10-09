/**
 * The flash layout, and the one place that decides which bytes the tool may address.
 *
 * Invariant: every offset this tool sends (ERASE, SUM, CRC, write address, WRITE) lies inside the window
 * [0x3000, 0x1FE00). The bootloader [0x0, 0x3000) and the option bytes [0x1FE00, 0x20000) are outside it.
 * Two mechanisms hold it:
 *   1. Construction. Offsets exist only as `Span` values built here from a validated `FlashWindow`.
 *      No exported function takes a raw address.
 *   2. The egress audit. protocol.ts `auditEgress` decodes every outgoing frame and calls `inWindow` on the range
 *      it carries, or on the write cursor a WRITE lands on, right before `link.send`. It is the last check before an
 *      irreversible effect, so it stays even though (1) should make it unreachable. An audit failure is a bug
 *      report, never a user-facing condition.
 */
import { EXPECTED_LAYOUT } from "./device";
import { type Brand, type FlashAddr, notImplemented } from "./units";

/** The meaningful 52 bytes at absolute 0x400, read with READ BL INFO (0x12/0x00) in either mode. Only `parseBlInfo` builds it. */
export interface BlInfo {
	readonly bootVid: number;
	readonly bootPid: number;
	readonly fwOffset: number;
	readonly fwPages: number;
	readonly pageSize: number;
	/** "KB" plus the app PID in hex on the sibling boards. Shown, not checked. */
	readonly model: string;
	/** Bytes 4..20 as lowercase hex. Must equal EXPECTED_LAYOUT.identityHex. */
	readonly identityHex: string;
	/** All 52 bytes. The deep check shows their hash as a fingerprint; no reference value exists for the TAB 60. */
	readonly raw: Uint8Array;
}

export type LayoutRefusal =
	| { readonly code: "bl-info-short"; readonly bytes: number }
	| { readonly code: "identity-mismatch"; readonly got: string }
	| {
			readonly code: "layout-mismatch";
			readonly field: "fwOffset" | "pageSize" | "fwPages";
			readonly expected: number;
			readonly got: number;
	  }
	| { readonly code: "fw-info-disagrees"; readonly blInfoFwOffset: number; readonly fwInfoOffset: number }
	| { readonly code: "mode-disagrees"; readonly productIdSays: "app" | "iap"; readonly readModeSays: number };

declare const windowBrand: unique symbol;

/**
 * The writable flash: the version page [0x3000, 0x3200) and the app region [0x3200, 0x1FE00).
 * Built only by `windowFor`, after the board's own BL info matched EXPECTED_LAYOUT field by field.
 */
export interface FlashWindow {
	readonly [windowBrand]: true;
	/** 0x3000. Window offsets count from here, as the protocol's do. */
	readonly base: FlashAddr;
	/** 0x3200. */
	readonly imageBase: FlashAddr;
	/** 0x1FE00, exclusive. */
	readonly end: FlashAddr;
	readonly pageSize: number;
}

/** Offset from the window base, inside the window. Built only by the span functions below. */
export type WindowOffset = Brand<number, "WindowOffset">;

/** A byte range inside the window. The protocol encodes only these. */
export interface Span {
	readonly offset: WindowOffset;
	readonly length: number;
}

/**
 * Parses the BL INFO reply payload (struct `<IIHHHHIIIIHHH10sI`, R1).
 * TODO: reject when payload.length < 52; read fw_offset at 0x20, fw_pages at 0x22, page_size at 0x24,
 * boot_vid at 0x08, boot_pid at 0x0A, model as ASCII at 0x26..0x30; identityHex = hex(payload[4..20]).
 */
export function parseBlInfo(payload: Uint8Array): BlInfo | LayoutRefusal {
	return notImplemented(`parseBlInfo(${payload.length} bytes)`);
}

/**
 * Builds the window, or refuses the board.
 * TODO:
 *   if info.identityHex !== EXPECTED_LAYOUT.identityHex -> identity-mismatch
 *   for field of [fwOffset, pageSize, fwPages]: if info[field] !== EXPECTED_LAYOUT[field] -> layout-mismatch
 *   if fwInfoOffset !== null and fwInfoOffset !== info.fwOffset -> fw-info-disagrees
 *     (update mode only: the vendor updater takes its write address from FW INFO, pok3rtool from BL info; both must agree)
 *   base = protocolBase; imageBase = base + fwOffset; end = base + fwPages * pageSize
 */
export function windowFor(info: BlInfo, fwInfoOffset: number | null): FlashWindow | LayoutRefusal {
	return notImplemented(`windowFor(${info.model}, ${String(fwInfoOffset)}) against ${EXPECTED_LAYOUT.identityHex}`);
}

/**
 * [0, pageSize): the version page, the first of the two erases. The IAP boots the image only while this page holds
 * its magic, so erasing it by its own command before any app page changes means an interruption at any later point
 * leaves the board in update mode (R1, INFERRED). One ERASE over the whole window would depend on the IAP erasing
 * pages in ascending order, which nothing documents; testing/reconcile-model.ts shows the damaged boot that order
 * risk allows.
 */
export function versionPage(window: FlashWindow): Span {
	return notImplemented(`versionPage(${window.pageSize})`);
}

/** [fwOffset, end - base): every app page, the second erase. */
export function appRegion(window: FlashWindow): Span {
	return notImplemented(`appRegion(${window.imageBase}..${window.end})`);
}

/** [fwOffset, fwOffset + imageBytes), or null when the image does not fit before the window end. */
export function imageSpan(window: FlashWindow, imageBytes: number): Span | null {
	return notImplemented(`imageSpan(${window.end}, ${imageBytes})`);
}

/** [0, 180). The version block, written last. */
export function versionSpan(window: FlashWindow): Span {
	return notImplemented(`versionSpan(${window.base})`);
}

/**
 * The window check the egress audit runs. True when [offset, offset + length) lies inside the window, computed without
 * 32-bit wraparound (an offset such as 0xFFFFD000 would wrap to absolute 0x0 inside a device that adds it to 0x3000).
 */
export function inWindow(window: FlashWindow, offset: number, length: number): boolean {
	return (
		Number.isInteger(offset) &&
		Number.isInteger(length) &&
		offset >= 0 &&
		length > 0 &&
		offset + length <= window.end - window.base
	);
}

export type RegionName = "bootloader" | "version-page" | "app" | "option-bytes";

export interface Region {
	readonly name: RegionName;
	readonly from: FlashAddr;
	readonly to: FlashAddr;
	readonly writable: boolean;
}

/** The four regions in address order, derived from the window. The flash map in the UI and the deep-check report use it. */
export function regions(window: FlashWindow): readonly Region[] {
	return notImplemented(`regions(${window.base}..${window.end})`);
}
