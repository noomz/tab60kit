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

import { versionBlock } from "./fake-tab60";

/** The fake board's V1.01.13-shaped page as hex: the shape of R1 "Version page", not the vendor's bytes. */
export const VERSION_PAGE_HEX = Array.from(versionBlock(), (b) => b.toString(16).padStart(2, "0")).join("");
