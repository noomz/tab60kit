import { expect, test } from "bun:test";
import { EXPECTED_LAYOUT } from "../core/device";
import { appRegion, imageSpan, parseBlInfo, regions, versionPage, versionSpan, windowFor } from "../core/flashmap";
import type { BlInfo, FlashWindow, Region, Span } from "../core/flashmap";
import { BL_INFO_HEX } from "./fixtures";


const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (b) => parseInt(b, 16));
const payload = fromHex(BL_INFO_HEX);
const info = parseBlInfo(payload) as BlInfo;
const window = windowFor(info, null) as FlashWindow;
const plain = (span: Span | null) => (span === null ? null : { offset: Number(span.offset), length: span.length });
const plainRegion = (region: Region) => ({ ...region, from: Number(region.from), to: Number(region.to) });

test("parseBlInfo reads every field of R1's struct", () => {
	expect(payload).toHaveLength(60);
	expect(info).toMatchObject({
		bootVid: 0x04d9,
		bootPid: 0x1304,
		fwOffset: 0x200,
		fwPages: 0xe7,
		pageSize: 0x200,
		model: "KB0304",
		identityHex: "00000000d904041340700404ffffffff",
	});
	expect(info.raw).toEqual(payload.subarray(0, 52));
});

test("parseBlInfo refuses a payload shorter than the 52-byte struct", () => {
	expect(parseBlInfo(payload.subarray(0, 51))).toEqual({ code: "bl-info-short", bytes: 51 });
});

test("windowFor builds [0x3000, 0x1FE00) with the image at 0x3200", () => {
	expect(window).toMatchObject({ base: 0x3000, imageBase: 0x3200, end: 0x1fe00, pageSize: 0x200 });
	expect(windowFor(info, 0x200)).toEqual(window);
});

test("windowFor refuses each layout difference by its own code", () => {
	const identity = { ...info, identityHex: "00000000d904041340700404fffffffe" };
	expect(windowFor(identity, null)).toEqual({ code: "identity-mismatch", got: identity.identityHex });
	expect(windowFor({ ...info, fwOffset: 0x400 }, null)).toEqual({ code: "layout-mismatch", field: "fwOffset", expected: 0x200, got: 0x400 });
	expect(windowFor({ ...info, pageSize: 0x400 }, null)).toEqual({ code: "layout-mismatch", field: "pageSize", expected: 0x200, got: 0x400 });
	expect(windowFor({ ...info, fwPages: 0x33 }, null)).toEqual({ code: "layout-mismatch", field: "fwPages", expected: 0xe7, got: 0x33 });
	expect(windowFor(info, 0x400)).toEqual({ code: "fw-info-disagrees", blInfoFwOffset: 0x200, fwInfoOffset: 0x400 });
});

test("the spans: version page, app region, image, and version block", () => {
	expect(plain(versionPage(window))).toEqual({ offset: 0, length: 0x200 });
	expect(plain(appRegion(window))).toEqual({ offset: 0x200, length: 0x1cc00 });
	expect(plain(imageSpan(window, 34_268))).toEqual({ offset: 0x200, length: 34_268 });
	expect(plain(imageSpan(window, 0x1cc00))).toEqual({ offset: 0x200, length: 0x1cc00 });
	expect(imageSpan(window, 0x1cc01)).toBeNull();
	expect(imageSpan(window, 0)).toBeNull();
	expect(plain(versionSpan(window))).toEqual({ offset: 0, length: EXPECTED_LAYOUT.versionBlockBytes });
});

test("regions tile the chip in address order", () => {
	expect(regions(window).map(plainRegion)).toEqual([
		{ name: "bootloader", from: 0, to: 0x3000, writable: false },
		{ name: "version-page", from: 0x3000, to: 0x3200, writable: true },
		{ name: "app", from: 0x3200, to: 0x1fe00, writable: true },
		{ name: "option-bytes", from: 0x1fe00, to: 0x20000, writable: false },
	]);
});
