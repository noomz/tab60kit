import type { Mode } from "./units";

/**
 * How the TAB 60 shows up on USB. The HID filters, the Linux udev rule, the product-ID-to-mode mapping,
 * and the chooser copy all derive from this one object, so adding the bootloader PID in one place adds it everywhere.
 */
export const TAB60 = {
	vendorId: 0x04d9,
	/** app: measured. iap: the package trailer's boot_pid plus pok3rtool's 0x1000 rule. docs/units.md U1 observes it. */
	productId: { app: 0x0304, iap: 0x1304 },
	/** Vendor collection on interface 1: 64-byte input and output reports, report ID 0, no feature reports (measured, macOS). */
	usagePage: 0xff00,
	usage: 0x0001,
	interfaceNumber: 1,
	reportBytes: 64,
	/** iap: the product string of five sibling CYKB bootloaders (docs/webhid.md D4). */
	productName: { app: "USB-HID Keyboard", iap: "USB-HID IAP" },
} as const;

/**
 * The flash layout this tool writes to. A board whose BL info disagrees is refused, never adapted to.
 * Source: docs/protocol.md "Flash map" and "BL info block"; docs/updater-package.md trailer identity.
 */
export const EXPECTED_LAYOUT = {
	/** ERASE, SUM, CRC, and the write address are offsets from this absolute address. */
	protocolBase: 0x3000,
	/** Image base 0x3200. Verified by the V1.01.13 vector table. */
	fwOffset: 0x200,
	pageSize: 0x200,
	/** 0x3000 + 0xE7 * 0x200 = 0x1FE00, the option-byte page. Inferred from the Cypher sibling. */
	fwPages: 0xe7,
	/**
	 * BL info bytes 4..20, which the vendor updater compares with its package identity block ("HW Setup Error!").
	 * Field by field: b = 0, boot_vid 0x04D9, boot_pid 0x1304, 0x7040, 0x0404, 0xFFFFFFFF.
	 */
	identityHex: "00000000d904041340700404ffffffff",
	versionBlockBytes: 180,
	/** One period of the 13-word XOR key, and the package's write_block_size. */
	writeChunkBytes: 52,
} as const;

export interface HidFilter {
	readonly vendorId: number;
	readonly productId: number;
	readonly usagePage: number;
	readonly usage: number;
}

/** The mode a product ID means, or null for any other device. */
export function modeOf(productId: number): Mode | null {
	if (productId === TAB60.productId.app) return "app";
	if (productId === TAB60.productId.iap) return "iap";
	return null;
}

/** Chooser filters for the given modes. The usage-page filter keeps the keyboard interfaces out of the grant (docs/webhid.md C8). */
export function hidFilters(modes: readonly Mode[]): readonly HidFilter[] {
	return modes.map((mode) => ({
		vendorId: TAB60.vendorId,
		productId: TAB60.productId[mode],
		usagePage: TAB60.usagePage,
		usage: TAB60.usage,
	}));
}

/** Contents of /etc/udev/rules.d/70-vortex-tab60.rules. Grants the logged-in user the vendor interface in both modes. */
export function udevRules(): string {
	const hex = (n: number) => n.toString(16).padStart(4, "0");
	return (["app", "iap"] as const)
		.map(
			(mode) =>
				`SUBSYSTEM=="hidraw", ENV{ID_VENDOR_ID}=="${hex(TAB60.vendorId)}", ENV{ID_MODEL_ID}=="${hex(TAB60.productId[mode])}", ` +
				`ENV{ID_USB_INTERFACE_NUM}=="${TAB60.interfaceNumber.toString().padStart(2, "0")}", TAG+="uaccess"`,
		)
		.join("\n");
}
