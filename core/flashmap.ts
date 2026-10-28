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
import type { Brand, FlashAddr } from "./units";

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
	| { readonly code: "mode-disagrees"; readonly productIdSays: "app" | "iap"; readonly readModeSays: number };

declare const windowBrand: unique symbol;

const BL_INFO_BYTES = 52;

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

function addr(n: number): FlashAddr {
	if (!Number.isInteger(n) || n < 0 || n > 0x20000) throw new RangeError(`not a flash address: ${n}`);
	return n as FlashAddr;
}

function windowOffset(n: number): WindowOffset {
	return n as WindowOffset;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function printablePrefix(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) {
		if (b < 0x20 || b > 0x7e) break;
		out += String.fromCharCode(b);
	}
	return out;
}

/** Parses the BL INFO reply payload (struct `<IIHHHHIIIIHHH10sI`, R1). */
export function parseBlInfo(payload: Uint8Array): BlInfo | LayoutRefusal {
	if (payload.length < BL_INFO_BYTES) return { code: "bl-info-short", bytes: payload.length };
	const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
	return {
		bootVid: view.getUint16(0x08, true),
		bootPid: view.getUint16(0x0a, true),
		fwOffset: view.getUint16(0x20, true),
		fwPages: view.getUint16(0x22, true),
		pageSize: view.getUint16(0x24, true),
		model: printablePrefix(payload.subarray(0x26, 0x30)),
		identityHex: hex(payload.subarray(4, 20)),
		raw: payload.slice(0, BL_INFO_BYTES),
	};
}

export function windowFor(info: BlInfo): FlashWindow | LayoutRefusal {
	if (info.identityHex !== EXPECTED_LAYOUT.identityHex) return { code: "identity-mismatch", got: info.identityHex };
	for (const field of ["fwOffset", "pageSize", "fwPages"] as const) {
		if (info[field] !== EXPECTED_LAYOUT[field]) {
			return { code: "layout-mismatch", field, expected: EXPECTED_LAYOUT[field], got: info[field] };
		}
	}
	const base = EXPECTED_LAYOUT.protocolBase;
	const window: Omit<FlashWindow, typeof windowBrand> = {
		base: addr(base),
		imageBase: addr(base + info.fwOffset),
		end: addr(base + info.fwPages * info.pageSize),
		pageSize: info.pageSize,
	};
	return window as FlashWindow;
}

/**
 * [0, pageSize): the version page, the first of the two erases. The IAP boots the image only while this page holds
 * its magic, so erasing it by its own command before any app page changes means an interruption at any later point
 * leaves the board in update mode (R1, INFERRED). One ERASE over the whole window would depend on the IAP erasing
 * pages in ascending order, which nothing documents; testing/reconcile-model.ts shows the damaged boot that order
 * risk allows.
 */
export function versionPage(window: FlashWindow): Span {
	return { offset: windowOffset(0), length: window.pageSize };
}

/** [fwOffset, end - base): every app page, the second erase. */
export function appRegion(window: FlashWindow): Span {
	return { offset: windowOffset(window.imageBase - window.base), length: window.end - window.imageBase };
}

/**
 * [0, end - base): the vendor's one ERASE (U2 F2). eraseWindow sends it only as the fallback for an IAP that refuses
 * appRegion's erase, after versionPage's erase was answered, so the page is already gone whatever order it erases in.
 */
export function wholeWindow(window: FlashWindow): Span {
	return { offset: windowOffset(0), length: window.end - window.base };
}

/** [fwOffset, fwOffset + imageBytes), or null when the image does not fit before the window end. */
export function imageSpan(window: FlashWindow, imageBytes: number): Span | null {
	if (!Number.isInteger(imageBytes) || imageBytes <= 0 || window.imageBase + imageBytes > window.end) return null;
	return { offset: windowOffset(window.imageBase - window.base), length: imageBytes };
}

/** [0, 180). The version block, written last. */
export function versionSpan(window: FlashWindow): Span {
	return { offset: windowOffset(0), length: EXPECTED_LAYOUT.versionBlockBytes };
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
	return [
		{ name: "bootloader", from: addr(0), to: window.base, writable: false },
		{ name: "version-page", from: window.base, to: window.imageBase, writable: true },
		{ name: "app", from: window.imageBase, to: window.end, writable: true },
		{ name: "option-bytes", from: window.end, to: addr(window.end + window.pageSize), writable: false },
	];
}
