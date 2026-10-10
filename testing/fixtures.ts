/** Byte-level expectations written from the research documents, independent of the core's codec. */

// The READ BL INFO payload for this board, written from R1 "BL info block" (struct <IIHHHHIIIIHHH10sI) with the
// TAB 60 values docs/units.md U1 expects, then the 8 zero bytes the app appends (R4 0x7650).
export const BL_INFO_HEX =
	"04000000" + // a
	"00000000" + // b
	"d904" + // boot_vid
	"0413" + // boot_pid
	"4070" + // c
	"0404" + // d
	"ffffffff" + // e
	"01000000" + // f
	"ffffffff" + // g
	"06010000" + // h
	"0002" + // fw_offset
	"e700" + // fw_pages
	"0002" + // page_size
	"4b423033303400000000" + // model "KB0304"
	"ffffffff" + // m
	"0000000000000000";

/**
 * A version page shaped like R1 "Version page": u32 byte length 0x1A, then "V1.01.13" as UTF-16LE in a 26-byte
 * field, 0xFF up to 0x78, the fixed words, the app VID:PID, and the 0x5AA5 magic at 0xB0. It is not the vendor's
 * block (its bytes are not public), so it hashes to no catalog entry.
 */
export const VERSION_PAGE_HEX = (() => {
	const page = new Uint8Array(180).fill(0xff);
	const view = new DataView(page.buffer);
	view.setUint32(0, 0x1a, true);
	page.set(new Uint8Array(26), 4);
	page.set(Array.from("V1.01.13", (c) => c.charCodeAt(0)).flatMap((b) => [b, 0]), 4);
	view.setUint32(0x78, 0x00800004, true);
	view.setUint32(0x7c, 0x4, true);
	view.setUint32(0x80, 0x142, true);
	view.setUint32(0x84, 0xefffffff, true);
	view.setUint32(0x88, 0x1, true);
	view.setUint32(0x8c, 0x0, true);
	view.setUint16(0x90, 0x04d9, true);
	view.setUint16(0x92, 0x0304, true);
	view.setUint32(0xb0, 0x00ff5aa5, true);
	return Array.from(page, (b) => b.toString(16).padStart(2, "0")).join("");
})();
