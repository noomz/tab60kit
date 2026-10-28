/**
 * Talking to the CYKB firmware on the vendor interface: the command registry, the single path to the wire,
 * and one session type per mode. Internal to the core. Nothing outside the package can import it.
 *
 * Every byte the tool sends leaves through `transmit`, which encodes a request and then audits the exact 64 bytes
 * before the link sees them. The audit does not trust the encoder. It decodes the frame the way the board will and
 * checks it against four things, each owned in one place:
 *   - The registry. COMMANDS lists every (cmd, sub) the tool may send and the payload each carries. Any other pair,
 *     or any other byte, is refused.
 *   - G1, per command. A shipped kit sends only rows whose evidence maturity is "confirmed". A lab kit sends exactly
 *     the commands its clearance names, each at least "reviewed".
 *   - Mode. A command the current firmware does not implement is refused. The session types also make the wrong call
 *     hard to write: flash operations exist only on IapSession.
 *   - The window. Every address the frame carries, and the write cursor a WRITE lands on, must lie inside the window
 *     validated at attach. Erases must be page-aligned.
 * Only the audit makes an `OutReport`, the one type `Link.send` accepts.
 *
 * How the evidence was learned. The official updater and the V1.01.13 firmware it carries were read as bytes. They
 * were never run, and no Vortex bytes are in this repository or redistributed. They were read only to learn the
 * commands and data formats needed to talk to the keyboard. Every address in an evidence string cites V1.01.13 (the
 * updater exe, or the app image linked at 0x3200), so anyone with the same files can check it. In those strings, R1
 * means docs/protocol.md, R2 docs/updater-package.md, and R4 docs/app-firmware.md. "U2" marks an address in the
 * updater exe that the audit of the vendor updater (unit U2, docs/units.md) traced to the frame it builds or sends.
 */
import { EXPECTED_LAYOUT, TAB60 } from "./device";
import { type FlashableImage, imageBytes } from "./firmware";
import { type BlInfo, type FlashWindow, type LayoutRefusal, type Span, appRegion, imageSpan, inWindow, parseBlInfo, versionPage, versionSpan, wholeWindow, windowFor } from "./flashmap";
import type { Layer, OsMode, Usage } from "./keymap";
import { type Clock, type DevicePort, type DeviceWant, type InReport, type Link, LinkLost, LinkTimeout, type OutReport, type WantReason } from "./port";
import { type Crc32, type Mode, type Sum32, crc32Literal, notImplemented, sum32Literal } from "./units";

/** What a command does to the board. The gate and the UI read this, never the opcode. */
export type Effect = "read" | "reboot" | "erase" | "write" | "sram-write";

/**
 * Where the command is known from. The maintainer's G1 ruling allows, after review, "the commands the vendor updater
 * itself sends". So "vendor-updater" is the only source that can carry an erase or write row above "unreviewed".
 */
export type Evidence =
	| { readonly source: "vendor-updater"; readonly at: string }
	| { readonly source: "pok3rtool"; readonly at: string }
	| { readonly source: "app-disassembly"; readonly at: string };

/**
 * G1 as evidence maturity, per command. A row moves up only in a reviewed commit:
 *   unreviewed -> reviewed    the maintainer reviewed the row. A lab clearance that names it may send it.
 *   reviewed   -> confirmed   a capture of this command on this board exists. Shipped builds may send it.
 * The ladder breaks the loop a single "approved" state had: approval needed a capture, and the capture needed
 * the command sent. probes/policy.test.ts fails when an erase or write row sits above "unreviewed" with evidence
 * other than "vendor-updater".
 */
export type Maturity =
	| { readonly level: "unreviewed" }
	| { readonly level: "reviewed"; readonly by: string; readonly on: string }
	| { readonly level: "confirmed"; readonly by: string; readonly on: string; readonly capture: string };

/**
 * Where a frame carries flash addresses, so the audit decodes them the way the board will (docs/protocol.md "Packet framing").
 *   none         no address
 *   range        u32 offset at byte 4, u32 length at byte 8 (ERASE, SUM, CRC)
 *   set-cursor   u32 offset at byte 4 becomes the board's write cursor (set write address)
 *   at-cursor    the payload lands at the write cursor, and the sub byte is its length (WRITE)
 *   read-cursor  u32 0xFFFFFFFF at byte 4 asks for the board's write cursor, which the reply carries (get write address)
 */
export type Addressing = "none" | "range" | "set-cursor" | "at-cursor" | "read-cursor";

/** Sub-commands `first` to `first + count - 1`. Part i of a request is sub `first + i`. */
export interface SubRange {
	readonly first: number;
	readonly count: number;
}

/** Inclusive bounds for one byte. */
export interface ByteBounds {
	readonly min: number;
	readonly max: number;
}

/**
 * What request bytes 2..3 may carry, read as the u16 LE argument the app firmware takes (docs/app-firmware.md, 0x7BA6
 * `ldrh r5,[r4,#2]`): bounds for its high byte and for its low byte.
 */
export interface ArgRule {
	readonly high: ByteBounds;
	readonly low: ByteBounds;
}

export interface CommandSpec {
	readonly label: string;
	readonly cmd: number;
	/** A fixed sub, a range of parts, or "length" for WRITE, whose sub byte is the payload length (1 to 52). */
	readonly sub: number | SubRange | "length";
	readonly modes: readonly Mode[];
	readonly effect: Effect;
	/**
	 * echo: bytes 0..1 repeat cmd and sub. echo-arg: bytes 0..3 repeat cmd, sub, and the argument; the vendor's reply
	 * filter accepts nothing less (U2, 0x4076FB..0x40770D), so every IAP row takes it. echo-cmd: byte 0 repeats cmd and
	 * bytes 1..3 carry an answer. write-ack: 0x1E 0x02 then the u32 next offset. none: the board resets instead.
	 */
	readonly reply: "echo" | "echo-arg" | "echo-cmd" | "write-ack" | "none";
	readonly timeoutMs: number;
	readonly address: Addressing;
	/**
	 * How many bytes from byte 4 the frame carries: 0 unaddressed, 8 for a range, 4 for set-cursor, 2 for a row with a
	 * `value`, and "sub" for WRITE, whose sub byte is its length.
	 */
	readonly payloadBytes: number | "sub";
	readonly arg: ArgRule;
	/** What request bytes 4..5 may carry, read as a u16 LE value with the same byte bounds as `arg`. null: no value. */
	readonly value: ArgRule | null;
	/** The editor capability this command is part of. keymap.ts derives its locks from this field. */
	readonly unlocks: "keymap-read" | "keymap-write" | "os-mode" | null;
	readonly evidence: Evidence;
	readonly maturity: Maturity;
}

const UNREVIEWED = { level: "unreviewed" } as const;
const CONFIRMED_BY_U1 = { level: "confirmed", by: "Siriwat Uamngamsup", on: "2026-10-12", capture: "fixtures/u1-macos.json" } as const;
const CONFIRMED_BY_U10 = { level: "confirmed", by: "Siriwat Uamngamsup", on: "2026-10-19", capture: "fixtures/u10-macos.json" } as const;
const CONFIRMED_BY_U11 = { level: "confirmed", by: "Siriwat Uamngamsup", on: "2026-10-24", capture: "fixtures/u11-macos.json" } as const;
const CONFIRMED_BY_U7 = { level: "confirmed", by: "Siriwat Uamngamsup", on: "2026-10-28", capture: "fixtures/u7-macos.json" } as const;

/**
 * Bytes 2..3 held at zero. The IAP rows send 0x0000 as pok3rtool does (docs/protocol.md "Packet framing", VERIFIED in its source),
 * which U1 captured on this board and U7 captured on erase, set and get write address, and write; the app treats the field as an argument, and these rows take none.
 */
const NO_ARG = { high: { min: 0, max: 0 }, low: { min: 0, max: 0 } } as const satisfies ArgRule;

/**
 * Every command the tool can send. Commands the design does not use (PING, DISCONNECT, and the patched-firmware
 * READ 0xFF) are left out on purpose, so the audit refuses them. Evidence addresses for vendor-updater rows are call
 * sites in the V1.01.13 updater exe, each one a place its disassembly shows the frame built or sent. G1 forbids a row
 * until the maintainer reviews it and a lab session captures it (docs/units.md U1, U7, U10, U11).
 */
export const COMMANDS = {
	readBlInfo: {
		label: "Read bootloader info",
		cmd: 0x12,
		sub: 0x00,
		modes: ["app", "iap"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x40839D, sent 0x404749 (GetInfo) and 0x4050B9 (flash); identity compare 0x404E80" },
		maturity: CONFIRMED_BY_U1,
	},
	readFwInfo: {
		label: "Read firmware info",
		cmd: 0x12,
		sub: 0x01,
		modes: ["iap"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x4084C9, sent 0x40482C; payload[2..3] picks version part 0x20+x" },
		maturity: CONFIRMED_BY_U1,
	},
	readMode: {
		label: "Read mode",
		cmd: 0x12,
		sub: 0x02,
		modes: ["app", "iap"],
		effect: "read",
		reply: "echo-arg",
		/** At least WRITE_LINK_RULE.maxProbeGapMs (flash.ts), so a slow answer is judged by the link gate and check 9 instead of thrown. */
		timeoutMs: 1_000,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "pok3rtool", at: "cykb.py:132-135; R4 app handler 0x767A" },
		maturity: CONFIRMED_BY_U1,
	},
	readVersionPage: {
		label: "Read version page",
		cmd: 0x12,
		/** The board serves parts 0 to 7, 60 bytes each from absolute 0x3000 + 60 * i (docs/app-firmware.md 0x7620, VERIFIED). The tool reads the 180-byte block, parts 0 to 2. */
		sub: { first: 0x20, count: 3 },
		modes: ["app", "iap"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x408613, sent 0x4047C7, 0x404841, 0x4057E1 (read-back of parts 0..2)" },
		maturity: CONFIRMED_BY_U1,
	},
	resetToIap: {
		label: "Restart into update mode",
		cmd: 0x11,
		sub: 0x00,
		modes: ["app"],
		effect: "reboot",
		reply: "none",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x4082DB (sub 0 when arg = 1), sent 0x4068A7, no reply wait" },
		maturity: CONFIRMED_BY_U1,
	},
	resetToApp: {
		label: "Restart into normal mode",
		cmd: 0x11,
		sub: 0x01,
		modes: ["iap"],
		effect: "reboot",
		reply: "none",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x405A58, sent 0x405A95, no reply wait" },
		maturity: CONFIRMED_BY_U1,
	},
	erase: {
		label: "Erase pages",
		cmd: 0x1d,
		sub: 0x00,
		modes: ["iap"],
		effect: "erase",
		reply: "echo-arg",
		timeoutMs: 15_000,
		address: "range",
		payloadBytes: 8,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x408754 (offset 0, length EDI), sent 0x405164 (window), 0x405885 (version page), 0x405CC8 (failure)" },
		maturity: CONFIRMED_BY_U7,
	},
	sum: {
		label: "Sum of a range",
		cmd: 0x1d,
		sub: 0x01,
		modes: ["iap"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 2_000,
		address: "range",
		payloadBytes: 8,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x4087E2, sent 0x405422 over (BL[0x24], size)" },
		maturity: CONFIRMED_BY_U1,
	},
	crc: {
		label: "CRC-32 of a range",
		cmd: 0x1d,
		sub: 0x02,
		modes: ["iap"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 2_000,
		address: "range",
		payloadBytes: 8,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "pok3rtool", at: "cykb.py:237-250 (the vendor updater checks the sum only)" },
		maturity: UNREVIEWED,
	},
	setWriteAddress: {
		label: "Set write address",
		cmd: 0x1e,
		sub: 0x01,
		modes: ["iap"],
		effect: "write",
		reply: "echo-arg",
		/** The vendor's wait (U2, 0x408975), raised from pok3rtool's 500 ms by the maintainer's ruling on the U2 audit. */
		timeoutMs: 1_000,
		address: "set-cursor",
		payloadBytes: 4,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x408919, sent 0x404F78 inside 0x404F60, called from 0x4051B2 (BL[0x24]), 0x405538 (0), and the write retries 0x4052CF, 0x405653" },
		maturity: CONFIRMED_BY_U7,
	},
	getWriteAddress: {
		label: "Get write address",
		cmd: 0x1e,
		sub: 0x00,
		modes: ["iap"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "read-cursor",
		payloadBytes: 4,
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x4089F9..0x408A01, sent 0x404F90 inside 0x404F60" },
		maturity: CONFIRMED_BY_U7,
	},
	write: {
		label: "Write up to 52 bytes",
		cmd: 0x1f,
		sub: "length",
		modes: ["iap"],
		effect: "write",
		reply: "write-ack",
		timeoutMs: 500,
		address: "at-cursor",
		payloadBytes: "sub",
		arg: NO_ARG,
		value: null,
		unlocks: null,
		evidence: { source: "vendor-updater", at: "U2: built 0x408B2D (sub = length, memcpy to byte 4), sent 0x4052B2 (image), 0x405632 (version block)" },
		maturity: CONFIRMED_BY_U7,
	},
	cfgReadKeys: {
		label: "Read 16 layer-0 key overrides (cmd 0x52/0x21)",
		cmd: 0x52,
		sub: 0x21,
		modes: ["app"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		/** Frame a covers active usages 16a to 16a + 15. The board uses only arg & 0xF, so 16 and up would alias. */
		arg: { high: { min: 0, max: 0 }, low: { min: 0, max: 15 } },
		value: null,
		unlocks: "keymap-read",
		evidence: { source: "app-disassembly", at: "V1.01.13 cmd 0x52 entry 0x7FEC (no host-config gate); sub 0x21 at 0x809E..0x80DE; accessor sub_5E98 mode 3 at 0x5F0E" },
		maturity: CONFIRMED_BY_U10,
	},
	cfgReadKey: {
		label: "Read one key override (cmd 0x52/0x20)",
		cmd: 0x52,
		sub: 0x20,
		modes: ["app"],
		effect: "read",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		/** layer << 8 | active usage. sub_5E98 bounds the index at 0x2FF, so layers 0 to 2. */
		arg: { high: { min: 0, max: 2 }, low: { min: 0, max: 0xff } },
		value: null,
		unlocks: "keymap-read",
		evidence: { source: "app-disassembly", at: "V1.01.13 cmd 0x52 entry 0x7FEC (no host-config gate); sub 0x20 at 0x807C..0x809A; accessor sub_5E98 mode 3 at 0x5F0E" },
		maturity: CONFIRMED_BY_U10,
	},
	gateQuery: {
		label: "Query the host-config gate (cmd 0x41, byte 1 = 0xFF)",
		cmd: 0x41,
		sub: 0xff,
		modes: ["app"],
		effect: "read",
		/** Byte 1 is the gate byte 0x200006FA and bytes 2..3 the u16 timer at 0x200006F8, so only byte 0 repeats. */
		reply: "echo-cmd",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: "keymap-write",
		evidence: { source: "app-disassembly", at: "V1.01.13 cmd 0x41 at 0x7CAE (no gate); 0xFF reads only, 0x7CB0 and 0x7CCE..0x7CD4" },
		maturity: CONFIRMED_BY_U11,
	},
	gateOpen: {
		label: "Open the host-config gate without config mode (cmd 0x41, byte 1 = 0x80)",
		cmd: 0x41,
		/** Bit 7 alone passes the 0x81 mask cmd 0x51 tests and skips config mode (bit 0), whose exit reloads flash. */
		sub: 0x80,
		modes: ["app"],
		effect: "sram-write",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		/** Bytes 2..3 become the gate timer; 0 never expires (0x8484). */
		arg: NO_ARG,
		value: null,
		unlocks: "keymap-write",
		evidence: { source: "app-disassembly", at: "V1.01.13 cmd 0x41 at 0x7CAE..0x7D08, sole store to 0x200006FA at 0x7CBE; bit 0 clear skips sub_721C and the 0x7CD6 reload" },
		maturity: CONFIRMED_BY_U11,
	},
	gateClose: {
		label: "Close the host-config gate (cmd 0x41, byte 1 = 0x00)",
		cmd: 0x41,
		sub: 0x00,
		modes: ["app"],
		effect: "sram-write",
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: "keymap-write",
		evidence: { source: "app-disassembly", at: "V1.01.13 cmd 0x41 at 0x7CAE..0x7D08; after 0x80 the old bit 0 is clear, so 0x7CD6 reloads nothing" },
		maturity: CONFIRMED_BY_U11,
	},
	cfgWriteKey: {
		label: "Write one key override (cmd 0x51/0x20)",
		cmd: 0x51,
		sub: 0x20,
		modes: ["app"],
		effect: "sram-write",
		/** Bytes 0..3 repeat; bytes 4..5 are the entry read back, as cmd 0x52/0x20 returns it. */
		reply: "echo-arg",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 2,
		/** layer << 8 | active usage, layers 0 to 2, as cfgReadKey. */
		arg: { high: { min: 0, max: 2 }, low: { min: 0, max: 0xff } },
		/** flags << 8 | code with flags 0 only: a plain usage, or 0x00FF for no override. Flags 1 to 3 are function codes or dead keys. */
		value: { high: { min: 0, max: 0 }, low: { min: 0, max: 0xff } },
		unlocks: "keymap-write",
		evidence: { source: "app-disassembly", at: "V1.01.13 cmd 0x51 entry 0x7EB2 refuses unless [0x200006FA] & 0x81; sub 0x20 at 0x7F34..0x7F4A calls sub_5E98, RAM only, no save; reply via the 0x52 read at 0x7FE4" },
		maturity: CONFIRMED_BY_U11,
	},
	cfgSetOsMode: {
		label: "Set OS mode (cmd 0x51/0x00)",
		cmd: 0x51,
		sub: 0x00,
		modes: ["app"],
		effect: "sram-write",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		payloadBytes: 0,
		arg: NO_ARG,
		value: null,
		unlocks: "os-mode",
		evidence: { source: "app-disassembly", at: "R4 0x7EF2 cmp r7,#5 then strb to 0x2000000F" },
		maturity: UNREVIEWED,
	},
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

/** The rows a flash needs beyond the read and reset rows. A kit that cannot send them stops before the first frame. */
export const FLASH_ROWS = ["erase", "setWriteAddress", "getWriteAddress", "write"] as const satisfies readonly CommandName[];

/** Every command name, in registry order. Object.keys of a const object is exactly its key union. */
export const COMMAND_NAMES = Object.keys(COMMANDS) as readonly CommandName[];

declare const labBrand: unique symbol;

/**
 * What one kit may send under G1. Shipped builds hold SHIPPED. A lab clearance names exactly the commands one
 * hardware session may send. Only `labClearance` builds one, and neither package entry exports it.
 */
export type Clearance =
	| { readonly kind: "shipped" }
	| {
			readonly kind: "lab";
			readonly [labBrand]: true;
			readonly only: readonly CommandName[];
			readonly purpose: string;
	  };

export const SHIPPED: Clearance = { kind: "shipped" };

/**
 * Lifts G1 for one hardware session (docs/units.md U1, U7, U10, U11). Refuses a command whose row is still unreviewed,
 * so the maintainer's review lands in a commit before the first packet. The session's transcript is the capture that
 * later moves the rows to "confirmed".
 */
export function labClearance(only: readonly CommandName[], purpose: string): Clearance {
	const unreviewed = only.filter((name) => {
		const spec: CommandSpec = COMMANDS[name];
		return spec.maturity.level === "unreviewed";
	});
	if (unreviewed.length > 0) throw new Error(`G1: review these rows before a lab session may send them: ${unreviewed.join(", ")}`);
	return { kind: "lab", only, purpose } as Clearance;
}

/**
 * Pure. Whether `clearance` lets a kit send `name`. Shipped: confirmed rows only. Lab: exactly the named commands,
 * each at least reviewed. An unreviewed row: never. `maturity` defaults to the registry's; tests pass others.
 */
export function clears(clearance: Clearance, name: CommandName, maturity: Maturity = COMMANDS[name].maturity): boolean {
	if (maturity.level === "unreviewed") return false;
	if (clearance.kind === "shipped") return maturity.level === "confirmed";
	return clearance.only.includes(name);
}

/** Why `clearance` does not clear `name`, in the words the locked editor and the Stopped screen show. */
export function gateMessage(name: CommandName, clearance: Clearance): string {
	const spec: CommandSpec = COMMANDS[name];
	const why =
		spec.maturity.level === "unreviewed"
			? "needs review and a capture on this board"
			: spec.maturity.level === "reviewed" && clearance.kind === "shipped"
				? "reviewed, needs a capture on this board"
				: "not named by this lab session";
	return `${spec.label}: ${why} (gate G1)`;
}

/** G1 refused the command for this kit's clearance. Nothing was sent. */
export class NotCleared extends Error {
	override readonly name = "NotCleared";
	constructor(
		readonly command: CommandName,
		readonly clearance: Clearance,
	) {
		super(gateMessage(command, clearance));
	}
}

/** The board answered with the FF AA error marker. */
export class DeviceRefused extends Error {
	override readonly name = "DeviceRefused";
	constructor(
		readonly command: CommandName,
		readonly detail: number,
	) {
		super(`${COMMANDS[command].label}: device error 0x${detail.toString(16)}`);
	}
}

/** The version page read back after writeVersionBlock differs from the block it wrote. The next observation decides. */
export class ReadBackMismatch extends Error {
	override readonly name = "ReadBackMismatch";
}

/** A flash step on an IapSession out of the safety order. A bug in the caller: nothing was sent. */
export class FlashOrderBroken extends Error {
	override readonly name = "FlashOrderBroken";
}

/** A WRITE ack named a next offset other than the cursor plus the chunk length. */
export class WrongNextOffset extends Error {
	override readonly name = "WrongNextOffset";
	constructor(
		readonly expected: number,
		readonly got: number,
	) {
		super(`the write ack named next offset 0x${got.toString(16)}, expected 0x${expected.toString(16)}`);
	}
}

/** Get write address, right after a set, read back an address other than the one set. */
export class CursorMismatch extends Error {
	override readonly name = "CursorMismatch";
	constructor(
		readonly set: number,
		readonly got: number,
	) {
		super(`the write address reads back 0x${got.toString(16)} after a set to 0x${set.toString(16)}`);
	}
}

/** Why the egress audit refused a frame. Every code but "not-cleared" means a bug in the core. */
export type EgressRefusal =
	| { readonly code: "bad-length"; readonly bytes: number }
	| { readonly code: "unknown-command"; readonly cmd: number; readonly sub: number }
	| { readonly code: "not-requested"; readonly decoded: CommandName; readonly requested: CommandName }
	| { readonly code: "not-cleared"; readonly command: CommandName }
	| { readonly code: "wrong-mode"; readonly command: CommandName; readonly mode: Mode }
	/** Bytes 2..3, as a u16 LE, outside what the row's `arg` allows. */
	| { readonly code: "arg-not-allowed"; readonly command: CommandName; readonly arg: number }
	/** Bytes 4..5, as a u16 LE, outside what the row's `value` allows, or get write address without its all-ones word. */
	| { readonly code: "value-not-allowed"; readonly command: CommandName; readonly value: number }
	/** `at` is the first nonzero byte past the payload the command's row declares. */
	| { readonly code: "payload-overrun"; readonly at: number }
	| { readonly code: "no-window"; readonly command: CommandName }
	| { readonly code: "outside-window"; readonly command: CommandName; readonly offset: number; readonly length: number }
	| { readonly code: "unaligned-erase"; readonly offset: number; readonly length: number }
	| { readonly code: "no-write-cursor" };

/** A bug: the encoder produced a frame the audit refused. Never caught. Nothing was sent. */
export class ProtocolInvariantBroken extends Error {
	override readonly name = "ProtocolInvariantBroken";
	constructor(readonly refusal: EgressRefusal) {
		super(`egress audit refused a frame: ${refusal.code}`);
	}
}

export interface EgressContext {
	readonly mode: Mode;
	/** Null until attach validated BL info, so no addressed frame leaves a session that has not attached. */
	readonly window: FlashWindow | null;
	/** The board's write cursor as audited frames and acknowledged writes moved it, or null before a set-address. */
	readonly cursor: number | null;
	readonly cleared: (command: CommandName) => boolean;
}

export type EgressVerdict =
	| {
			readonly ok: true;
			readonly frame: OutReport;
			readonly command: CommandName;
			/** The write cursor once the board accepts this frame. */
			readonly cursor: number | null;
	  }
	| { readonly ok: false; readonly refusal: EgressRefusal };

const PAYLOAD_OFFSET = 4;
/** What get write address carries: the vendor's in/out word, preset to all ones (U2, 0x404F88). */
const CURSOR_QUERY = 0xffff_ffff;
const MAX_PAYLOAD_BYTES = TAB60.reportBytes - PAYLOAD_OFFSET;

const within = (bounds: ByteBounds, byte: number) => byte >= bounds.min && byte <= bounds.max;

/** Whether a u16 LE field, bytes 2..3 or a row's value in bytes 4..5, is one `rule` allows. */
export function argAllowed(rule: ArgRule, arg: number): boolean {
	return within(rule.high, arg >>> 8) && within(rule.low, arg & 0xff);
}

function matchesSub(spec: CommandSpec, sub: number): boolean {
	if (spec.sub === "length") return sub >= 1 && sub <= EXPECTED_LAYOUT.writeChunkBytes;
	if (typeof spec.sub === "number") return spec.sub === sub;
	return sub >= spec.sub.first && sub < spec.sub.first + spec.sub.count;
}

/** The registry row a (cmd, sub) pair names, or null. policy.test.ts checks that no pair names two rows. */
export function decodeCommand(cmd: number, sub: number): CommandName | null {
	return COMMAND_NAMES.find((name) => COMMANDS[name].cmd === cmd && matchesSub(COMMANDS[name], sub)) ?? null;
}

/**
 * The egress audit, merged into the one write path. Pure. Decodes the exact bytes about to leave, with
 * no help from the encoder, and checks them against the registry, the clearance, the mode, every byte the row does not
 * declare, and the window.
 * The only place in the tree that makes an OutReport. Default deny: a pair the registry does not list is refused.
 */
export function auditEgress(frame: Uint8Array, requested: CommandName, ctx: EgressContext): EgressVerdict {
	const refuse = (refusal: EgressRefusal): EgressVerdict => ({ ok: false, refusal });
	if (frame.length !== TAB60.reportBytes) return refuse({ code: "bad-length", bytes: frame.length });
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const cmd = view.getUint8(0);
	const sub = view.getUint8(1);
	const command = decodeCommand(cmd, sub);
	if (command === null) return refuse({ code: "unknown-command", cmd, sub });
	if (command !== requested) return refuse({ code: "not-requested", decoded: command, requested });
	if (!ctx.cleared(command)) return refuse({ code: "not-cleared", command });
	const spec: CommandSpec = COMMANDS[command];
	if (!spec.modes.includes(ctx.mode)) return refuse({ code: "wrong-mode", command, mode: ctx.mode });
	const arg = view.getUint16(2, true);
	if (!argAllowed(spec.arg, arg)) return refuse({ code: "arg-not-allowed", command, arg });
	const value = view.getUint16(PAYLOAD_OFFSET, true);
	if (spec.value !== null && !argAllowed(spec.value, value)) return refuse({ code: "value-not-allowed", command, value });
	const payloadEnd = PAYLOAD_OFFSET + (spec.payloadBytes === "sub" ? sub : spec.payloadBytes);
	const overrun = frame.findIndex((byte, at) => at >= payloadEnd && byte !== 0);
	if (overrun !== -1) return refuse({ code: "payload-overrun", at: overrun });

	let cursor = ctx.cursor;
	if (spec.address !== "none") {
		const window = ctx.window;
		if (window === null) return refuse({ code: "no-window", command });
		const outside = (offset: number, length: number) => refuse({ code: "outside-window", command, offset, length });
		switch (spec.address) {
			case "range": {
				const offset = view.getUint32(4, true);
				const length = view.getUint32(8, true);
				if (!inWindow(window, offset, length)) return outside(offset, length);
				if (spec.effect === "erase" && (offset % window.pageSize !== 0 || length % window.pageSize !== 0)) {
					return refuse({ code: "unaligned-erase", offset, length });
				}
				break;
			}
			case "set-cursor": {
				const offset = view.getUint32(4, true);
				if (!inWindow(window, offset, 1)) return outside(offset, 1);
				cursor = offset;
				break;
			}
			case "at-cursor": {
				if (ctx.cursor === null) return refuse({ code: "no-write-cursor" });
				if (!inWindow(window, ctx.cursor, sub)) return outside(ctx.cursor, sub);
				cursor = ctx.cursor + sub;
				break;
			}
			case "read-cursor": {
				const asked = view.getUint32(4, true);
				if (asked !== CURSOR_QUERY) return refuse({ code: "value-not-allowed", command, value: asked });
				break;
			}
			default: {
				const exhaustive: never = spec.address;
				return exhaustive;
			}
		}
	}
	return { ok: true, frame: frame as OutReport, command, cursor };
}

/** One link plus the state the audit judges frames against. Each session owns one; nothing else holds it. */
interface Channel {
	readonly link: Link;
	readonly clock: Clock;
	readonly clearance: Clearance;
	/** Set once by attach after BL info validates. */
	window: FlashWindow | null;
	/** Moved only by transmit, after the board acknowledged an audited set-address or WRITE. */
	cursor: number | null;
}

/** What a request adds to its command: the part of a range command, the u16 argument in bytes 2..3, and the payload. */
interface Request {
	readonly part?: number;
	readonly arg?: number;
	readonly payload?: Uint8Array;
}

const ERROR_MARKER = [0xff, 0xaa] as const;

const viewOf = (report: Uint8Array) => new DataView(report.buffer, report.byteOffset, report.byteLength);
const payloadOf = (reply: InReport) => reply.subarray(PAYLOAD_OFFSET);

/** Builds the 64 bytes for a request. Nothing trusts its output: transmit audits every frame it builds. */
function encode(name: CommandName, request: Request): Uint8Array {
	const spec: CommandSpec = COMMANDS[name];
	const payload = request.payload ?? new Uint8Array(0);
	const arg = request.arg ?? 0;
	if (!Number.isInteger(arg) || arg < 0 || arg > 0xffff) throw new RangeError(`${name}: argument ${arg} is not a u16`);
	const maxPayload = spec.sub === "length" ? EXPECTED_LAYOUT.writeChunkBytes : MAX_PAYLOAD_BYTES;
	if (payload.length > maxPayload) throw new RangeError(`${name}: ${payload.length} payload bytes, at most ${maxPayload}`);
	let sub: number;
	if (spec.sub === "length") {
		if (payload.length === 0) throw new RangeError(`${name}: WRITE needs a payload`);
		sub = payload.length;
	} else if (typeof spec.sub === "number") {
		if (request.part !== undefined) throw new RangeError(`${name} has no parts`);
		sub = spec.sub;
	} else {
		const { part } = request;
		if (part === undefined || !Number.isInteger(part) || part < 0 || part >= spec.sub.count) {
			throw new RangeError(`${name}: part ${String(part)} is outside 0..${spec.sub.count - 1}`);
		}
		sub = spec.sub.first + part;
	}
	const frame = new Uint8Array(TAB60.reportBytes);
	const view = new DataView(frame.buffer);
	view.setUint8(0, spec.cmd);
	view.setUint8(1, sub);
	view.setUint16(2, arg, true);
	frame.set(payload, PAYLOAD_OFFSET);
	return frame;
}

type ReplyVerdict =
	| { readonly kind: "ack" }
	| { readonly kind: "refused"; readonly detail: number }
	| { readonly kind: "wrong-next"; readonly next: number }
	| { readonly kind: "stale" };

/**
 * The error marker counts only when bytes 4..5 name the command sent, as the vendor's reply filter requires (U2,
 * 0x407731..0x407748); any other marker is someone else's answer.
 */
function classifyReply(spec: CommandSpec, sent: Uint8Array, reply: InReport, cursor: number | null): ReplyVerdict {
	const view = viewOf(reply);
	if (reply[0] === ERROR_MARKER[0] && reply[1] === ERROR_MARKER[1]) {
		return reply[4] === sent[0] && reply[5] === sent[1] ? { kind: "refused", detail: view.getUint16(4, true) } : { kind: "stale" };
	}
	if (spec.reply === "write-ack") {
		if (reply[0] !== 0x1e || reply[1] !== 0x02) return { kind: "stale" };
		const next = view.getUint32(4, true);
		return next === cursor ? { kind: "ack" } : { kind: "wrong-next", next };
	}
	const echoed = spec.reply === "echo-arg" ? 4 : spec.reply === "echo-cmd" ? 1 : 2;
	return sent.subarray(0, echoed).every((byte, at) => reply[at] === byte) ? { kind: "ack" } : { kind: "stale" };
}

type SilentCommand = { [K in CommandName]: (typeof COMMANDS)[K]["reply"] extends "none" ? K : never }[CommandName];

/**
 * The single path from the core to the wire. `signal` is the job's, passed per call because a session outlives the
 * job that opened it. Once it is aborted, nothing leaves.
 */
function transmit(ch: Channel, name: SilentCommand, request: Request, signal: AbortSignal): Promise<null>;
function transmit(ch: Channel, name: Exclude<CommandName, SilentCommand>, request: Request, signal: AbortSignal): Promise<InReport>;
async function transmit(ch: Channel, name: CommandName, request: Request, signal: AbortSignal): Promise<InReport | null> {
	signal.throwIfAborted();
	const frame = encode(name, request);
	const verdict = auditEgress(frame, name, {
		mode: ch.link.mode,
		window: ch.window,
		cursor: ch.cursor,
		cleared: (command) => clears(ch.clearance, command),
	});
	if (!verdict.ok) {
		if (verdict.refusal.code === "not-cleared") throw new NotCleared(name, ch.clearance);
		throw new ProtocolInvariantBroken(verdict.refusal);
	}
	const spec: CommandSpec = COMMANDS[name];
	ch.link.discardPending();
	await ch.link.send(verdict.frame);
	if (spec.reply === "none") return null;
	const deadline = ch.clock.now() + spec.timeoutMs;
	let remaining = spec.timeoutMs;
	for (;;) {
		const reply = await ch.link.next(remaining);
		const outcome = classifyReply(spec, verdict.frame, reply, verdict.cursor);
		if (outcome.kind === "stale") {
			remaining = deadline - ch.clock.now();
			if (remaining <= 0) throw new LinkTimeout(`${spec.label}: no reply within ${spec.timeoutMs} ms`);
			continue;
		}
		if (outcome.kind === "refused" || outcome.kind === "wrong-next") {
			if (spec.address === "set-cursor" || spec.address === "at-cursor") ch.cursor = null;
			throw outcome.kind === "refused" ? new DeviceRefused(name, outcome.detail) : new WrongNextOffset(verdict.cursor ?? 0, outcome.next);
		}
		ch.cursor = verdict.cursor;
		return reply;
	}
}

function rangePayload(span: Span): Uint8Array {
	const payload = new Uint8Array(8);
	const view = new DataView(payload.buffer);
	view.setUint32(0, span.offset, true);
	view.setUint32(4, span.length, true);
	return payload;
}

const u32Of = (reply: InReport) => viewOf(reply).getUint32(PAYLOAD_OFFSET, true);

function u32Payload(value: number): Uint8Array {
	const payload = new Uint8Array(4);
	new DataView(payload.buffer).setUint32(0, value, true);
	return payload;
}

/**
 * Tries for each unit the vendor retries, by the maintainer's 2026-10-26 rulings on the U2 audit: the set and get write address pair, one
 * WRITE block, and the app-region ERASE before its fallback. The vendor tries 15 times; past these, the convergence
 * loop observes the board and decides.
 */
const TRIES = 3;

/** The vendor's Sleep 1000 between tries (U2). */
const RETRY_WAIT_MS = 1_000;

/**
 * Before a resend on the same link: wait out a late answer to the frame that failed, then drop it, so it cannot
 * answer the resend, whose bytes it may repeat.
 */
async function settle(ch: Channel): Promise<void> {
	await ch.clock.sleep(RETRY_WAIT_MS, NEVER_ABORTED);
	ch.link.discardPending();
}

/**
 * Sets the write address, reads it back, and requires the address set (U2: the vendor's pair at 0x404F60). The pair
 * is retried as one unit on a refusal, a silence, or a different read-back; a lost link ends it at once.
 */
async function setCursor(ch: Channel, offset: number): Promise<void> {
	for (let tries = 1; ; tries++) {
		try {
			await transmit(ch, "setWriteAddress", { payload: u32Payload(offset) }, NEVER_ABORTED);
			const got = u32Of(await transmit(ch, "getWriteAddress", { payload: u32Payload(CURSOR_QUERY) }, NEVER_ABORTED));
			if (got === offset) return;
			ch.cursor = null;
			throw new CursorMismatch(offset, got);
		} catch (error) {
			const retry = error instanceof DeviceRefused || error instanceof LinkTimeout || error instanceof CursorMismatch;
			if (!retry || tries === TRIES) throw error;
			await settle(ch);
		}
	}
}

/**
 * Sets the write address to the span, then WRITEs `bytes` in chunks of at most 52. Each ack must name the next address.
 * A block whose ack is missing or names another offset goes again from its own start, after the cursor is set back
 * and read back (U2: the vendor's 0x4052C5..0x4052CF). After TRIES the error goes to the caller's next observation.
 */
async function writeAt(ch: Channel, span: Span, bytes: Uint8Array, onChunk: (done: number, total: number) => void): Promise<void> {
	await setCursor(ch, span.offset);
	const size = EXPECTED_LAYOUT.writeChunkBytes;
	const chunks = Math.ceil(bytes.length / size);
	for (let i = 0; i < chunks; i++) {
		const payload = bytes.subarray(i * size, (i + 1) * size);
		for (let tries = 1; ; tries++) {
			try {
				if (tries > 1) await setCursor(ch, span.offset + i * size);
				await transmit(ch, "write", { payload }, NEVER_ABORTED);
				break;
			} catch (error) {
				const retry = error instanceof LinkTimeout || error instanceof WrongNextOffset;
				if (!retry || tries === TRIES) throw error;
				await settle(ch);
			}
		}
		onChunk(i + 1, chunks);
	}
}

/** READ MODE's payload byte 0 (docs/protocol.md "Commands"). */
const MODE_BYTE = { iap: 0, app: 1 } as const satisfies Record<Mode, number>;

async function readModeByte(ch: Channel, signal: AbortSignal): Promise<number> {
	return viewOf(await transmit(ch, "readMode", {}, signal)).getUint8(PAYLOAD_OFFSET);
}

/** READ MODE answered a byte other than the mode byte of the link that carried it. */
export class ModeDisagrees extends Error {
	override readonly name = "ModeDisagrees";
	constructor(
		readonly productIdSays: Mode,
		readonly readModeSays: number,
	) {
		super(`READ MODE answered ${readModeSays} on a ${productIdSays} link`);
	}
}

async function probe(ch: Channel, signal: AbortSignal): Promise<void> {
	const byte = await readModeByte(ch, signal);
	if (byte !== MODE_BYTE[ch.link.mode]) throw new ModeDisagrees(ch.link.mode, byte);
}

/** The 180-byte version page: parts 0, 1, and 2 of READ VERSION PAGE, 60 bytes each from absolute 0x3000 + 60 * i. */
export interface VersionPageRead {
	readonly bytes: Uint8Array;
}

async function readVersionPage(ch: Channel, signal: AbortSignal): Promise<VersionPageRead> {
	const { count } = COMMANDS.readVersionPage.sub;
	const bytes = new Uint8Array(count * MAX_PAYLOAD_BYTES);
	for (let part = 0; part < count; part++) {
		bytes.set(payloadOf(await transmit(ch, "readVersionPage", { part }, signal)), part * MAX_PAYLOAD_BYTES);
	}
	return { bytes };
}

/**
 * RESET to app is how a cancelled job sends the board home, and a flash step runs to its end once it starts (a cancel
 * stops the job at its next step boundary), so both leave under a signal that never aborts.
 */
const NEVER_ABORTED = new AbortController().signal;

async function restartToApp(ch: Channel): Promise<void> {
	try {
		await transmit(ch, "resetToApp", {}, NEVER_ABORTED);
	} finally {
		await ch.link.close();
	}
}

/**
 * The two flag bits the store keeps per cell (U11 research, Q3): 0 a plain HID usage, 1 a function code (profile, OS
 * mode, LED, some of which save flash), 2 and 3 a dead key in V1.01.13.
 */
export type OverrideFlags = 0 | 1 | 2 | 3;

/**
 * One entry of the per-key override store, addressed by an active usage, as cmd 0x52 returns it. "absent": no key in
 * the active keymap has that usage. "default": the key has no override and types its active usage. "override": the
 * store holds `code` for the key. The store keeps one raw byte per cell, so `code` may lie past the keyboard page
 * (0xE8..0xFE), where the firmware's other key codes live.
 */
export type OverrideEntry =
	| { readonly kind: "absent" }
	| { readonly kind: "default" }
	| { readonly kind: "override"; readonly code: number; readonly flags: OverrideFlags };

const ABSENT_WORD = 0x0003;
const DEFAULT_WORD = 0x00ff;

/**
 * What cfgWriteKey may store: no override, or a plain code with flags 0. A code of 0x03 would read back as absent, and
 * sub_5E98 refuses it; 0xFF is the default.
 */
export type OverrideValue = { readonly kind: "default" } | { readonly kind: "override"; readonly code: number; readonly flags: 0 };

/** The u16 cfgWriteKey carries in bytes 4..5. Throws RangeError on a code that is not 0x00..0xFE or is 0x03. */
export function overrideValueWord(value: OverrideValue): number {
	if (value.kind === "default") return DEFAULT_WORD;
	const { code } = value;
	if (!Number.isInteger(code) || code < 0 || code >= DEFAULT_WORD || code === ABSENT_WORD) throw new RangeError(`override code ${code} is not 0x00..0xFE without 0x03`);
	return code;
}

/**
 * Decodes one u16 the board returns for an entry (docs/app-firmware.md, 0x807C..0x80DE and sub_5E98 mode 3 at 0x5F0E):
 * 0x0003 absent, 0x00FF default, otherwise flags << 8 | code. Throws RangeError on a word that fits none of them:
 * flags above 3, which the firmware masks to 2 bits, or a code of 0xFF with flags set, which it reports as 0x00FF.
 */
export function parseOverrideEntry(word: number): OverrideEntry {
	if (word === ABSENT_WORD) return { kind: "absent" };
	if (word === DEFAULT_WORD) return { kind: "default" };
	const flags = word >>> 8;
	const code = word & 0xff;
	if (!Number.isInteger(word) || word < 0 || flags > 3 || code === 0xff) {
		throw new RangeError(`override word ${word < 0 || !Number.isInteger(word) ? word : `0x${word.toString(16).padStart(4, "0")}`} is not absent, default, or flags 0..3 with a code below 0xFF`);
	}
	return { kind: "override", code, flags: flags as OverrideFlags };
}

/** What the gate query reports: the gate byte at 0x200006FA and the timer at 0x200006F8. 0 is closed at boot. */
export interface GateState {
	readonly gate: number;
	readonly timer: number;
}

/**
 * The live config channel (app mode). Each method throws NotCleared, before anything leaves, unless the clearance
 * clears its commands. The reads return the per-key override store, not the active keymap, which no command returns
 * (docs/app-firmware.md). A write lands in RAM only and needs the gate open; a power cycle restores the saved store (U11).
 */
export interface ConfigChannel {
	/**
	 * Layer 0 of the override store, one entry for each active usage 0..255, in 16 cfgReadKeys frames. Only layer 0
	 * has a bulk read; readKey reads layers 1 and 2.
	 */
	readLayer0(signal: AbortSignal): Promise<ReadonlyMap<number, OverrideEntry>>;
	/** The entry for the key whose active usage is `usage`, on `layer`, in one cfgReadKey frame. */
	readKey(layer: Layer, usage: Usage, signal: AbortSignal): Promise<OverrideEntry>;
	queryGate(signal: AbortSignal): Promise<GateState>;
	/** Sets the gate byte to 0x80: cmd 0x51 accepted, no config mode, no timer. */
	openGate(signal: AbortSignal): Promise<void>;
	/** Sets the gate byte to 0. After openGate this reloads nothing, so RAM writes stay until a power cycle. */
	closeGate(signal: AbortSignal): Promise<void>;
	/**
	 * Writes the entry for the key whose active usage is `usage`, on `layer`, in one cfgWriteKey frame, and returns the
	 * entry the board reads back. DeviceRefused when the gate is closed or no key has that usage.
	 */
	writeKey(layer: Layer, usage: Usage, value: OverrideValue, signal: AbortSignal): Promise<OverrideEntry>;
	setOsMode(mode: OsMode): Promise<void>;
}

const OVERRIDES_PER_FRAME = 16;

const entryAt = (reply: InReport, i: number) => parseOverrideEntry(viewOf(reply).getUint16(PAYLOAD_OFFSET + 2 * i, true));

async function readLayer0(ch: Channel, signal: AbortSignal): Promise<ReadonlyMap<number, OverrideEntry>> {
	const entries = new Map<number, OverrideEntry>();
	for (let frame = 0; frame <= COMMANDS.cfgReadKeys.arg.low.max; frame++) {
		const reply = await transmit(ch, "cfgReadKeys", { arg: frame }, signal);
		for (let i = 0; i < OVERRIDES_PER_FRAME; i++) entries.set(frame * OVERRIDES_PER_FRAME + i, entryAt(reply, i));
	}
	return entries;
}

function configChannel(ch: Channel): ConfigChannel {
	const gated = (names: readonly CommandName[], what: string): never => {
		for (const name of names) if (!clears(ch.clearance, name)) throw new NotCleared(name, ch.clearance);
		return notImplemented(what);
	};
	return {
		readLayer0: (signal) => readLayer0(ch, signal),
		readKey: async (layer, usage, signal) => entryAt(await transmit(ch, "cfgReadKey", { arg: (layer << 8) | usage }, signal), 0),
		queryGate: async (signal) => {
			const view = viewOf(await transmit(ch, "gateQuery", {}, signal));
			return { gate: view.getUint8(1), timer: view.getUint16(2, true) };
		},
		openGate: async (signal) => {
			await transmit(ch, "gateOpen", {}, signal);
		},
		closeGate: async (signal) => {
			await transmit(ch, "gateClose", {}, signal);
		},
		writeKey: async (layer, usage, value, signal) => {
			const payload = new Uint8Array(2);
			new DataView(payload.buffer).setUint16(0, overrideValueWord(value), true);
			return entryAt(await transmit(ch, "cfgWriteKey", { arg: (layer << 8) | usage, payload }, signal), 0);
		},
		setOsMode: async (mode) => gated(["cfgSetOsMode"], `setOsMode(${mode})`),
	};
}

/** What opening a session needs: where links come from, what G1 lets this kit send, and the job's cancel signal. */
export interface LinkContext {
	readonly port: DevicePort;
	readonly clearance: Clearance;
	readonly signal: AbortSignal;
}

/**
 * Normal mode. Reads, the live config channel, and the restart into update mode.
 * Nothing on this type can address flash, and the app firmware has no flash-write code anyway (docs/app-firmware.md).
 * A method that takes the job's `signal` rejects with its reason, before its next command leaves, once it is aborted.
 */
export interface AppSession {
	readonly mode: "app";
	readonly info: BlInfo;
	readonly window: FlashWindow;
	readVersionPage(signal: AbortSignal): Promise<VersionPageRead>;
	/** READ MODE as a liveness probe. Resolves when the board answers 1, normal mode. */
	probe(signal: AbortSignal): Promise<void>;
	/**
	 * Restarts the board into update mode and returns the bootloader session, or the refusal that attach found
	 * there. This session is closed afterwards. The update-mode link is requested before the reset frame leaves,
	 * because a chooser opened inside the click's activation stays open and adds the row when the bootloader
	 * appears (docs/webhid.md C7). No reset leaves when that request has already failed or `ctx.signal` is aborted. An attach
	 * that throws rejects with IapAttachFailed, which holds the update-mode link open.
	 */
	enterIap(ctx: LinkContext): Promise<IapSession | IapRefused>;
	readonly config: ConfigChannel;
	close(): Promise<void>;
}

/**
 * Update mode. Every flash operation addresses the window validated at attach; none takes an address.
 * A method that takes the job's `signal` rejects with its reason, before its next command leaves, once it is aborted.
 */
export interface IapSession {
	readonly mode: "iap";
	readonly info: BlInfo;
	readonly window: FlashWindow;
	readVersionPage(signal: AbortSignal): Promise<VersionPageRead>;
	/** READ MODE as a liveness probe for the link gate (flash.ts). Resolves when the board answers 0, update mode. */
	probe(signal: AbortSignal): Promise<void>;
	/** SUM, plus CRC-32 when cleared, over [imageBase, imageBase + imageBytes). */
	checksum(imageBytes: number, signal: AbortSignal): Promise<{ readonly sum: Sum32; readonly crc: Crc32 | null }>;
	/**
	 * ERASE the version page (`versionPage(window)`), wait for its echo, then ERASE the app region (`appRegion(window)`).
	 * The page is gone before any app byte changes, whatever order the IAP erases pages within one command, so no
	 * interruption leaves a valid page over a damaged image (legacy pok3rtool's order, docs/protocol.md "Sequences").
	 * The vendor never erases from an offset above 0. If the IAP refuses the app-region erase with FF AA, or
	 * leaves it unanswered TRIES times, this sends the vendor's one ERASE over the whole window (`wholeWindow`). Only the
	 * answered version-page erase makes that safe, so any failure of the first erase propagates instead.
	 */
	eraseWindow(): Promise<void>;
	/**
	 * Sets the write address to the image offset and reads it back, then sends WRITE in 52-byte chunks of
	 * `imageBytes(image).wire`. Each ack must report next offset = cursor + chunk length. A block that fails is resent
	 * from its start (writeAt); one that keeps failing throws, and the caller's next observation decides what happens.
	 * Throws FlashOrderBroken, before anything leaves, unless eraseWindow completed on this session.
	 */
	writeImage(image: FlashableImage, onChunk: (done: number, total: number) => void): Promise<void>;
	/**
	 * Sets the write address to 0 and writes `imageBytes(image).versionBlock`, 180 bytes, as chunks of 52, 52, 52, and
	 * 24. The 0x5AA5 magic at offset 0xB0 sits in the last chunk, so a partial block never carries it. Then reads the
	 * page back and compares, as the vendor updater does. Throws FlashOrderBroken, before anything leaves, unless this
	 * session's latest SUM matched the image, with no erase or write since.
	 */
	writeVersionBlock(image: FlashableImage): Promise<void>;
	/** Restarts into normal mode. The session is closed afterwards; the board re-enumerates as 0x0304. */
	exitToApp(): Promise<void>;
	close(): Promise<void>;
}

export type Session = AppSession | IapSession;

/**
 * A board that attach refused, with its link still open so the caller can send it home. RESET to app does what the
 * board's next power cycle would do, because the IAP boots the app only over a version page with its magic (docs/protocol.md,
 * INFERRED), and without it a refused board stays in update mode, where the keyboard cannot type.
 */
export interface AppRefused {
	readonly mode: "app";
	readonly refusal: LayoutRefusal;
	readonly restartToApp: null;
	close(): Promise<void>;
}

export interface IapRefused {
	readonly mode: "iap";
	readonly refusal: LayoutRefusal;
	restartToApp(): Promise<void>;
	close(): Promise<void>;
}

export type Refused = AppRefused | IapRefused;

/**
 * An update-mode attach that threw. Its link stays open, because it is the way to send a board that cannot type home,
 * and the core never restarts on its own, because the caller decides when a reset is safe (U7 reads the board first).
 * Every caller must call restartToApp or close. `cause` is the error the attach threw.
 */
export class IapAttachFailed extends Error {
	override readonly name = "IapAttachFailed";
	readonly #ch: Channel;

	constructor(
		ch: Channel,
		override readonly cause: unknown,
	) {
		super(`attach in update mode failed: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
		this.#ch = ch;
	}

	/** RESET to app through transmit and the audit, then close, even when the send fails. */
	restartToApp(): Promise<void> {
		return restartToApp(this.#ch);
	}

	close(): Promise<void> {
		return this.#ch.link.close();
	}
}

class App implements AppSession {
	readonly mode = "app";
	readonly config: ConfigChannel;

	constructor(
		private readonly ch: Channel,
		readonly info: BlInfo,
		readonly window: FlashWindow,
	) {
		this.config = configChannel(ch);
	}

	readVersionPage(signal: AbortSignal): Promise<VersionPageRead> {
		return readVersionPage(this.ch, signal);
	}

	probe(signal: AbortSignal): Promise<void> {
		return probe(this.ch, signal);
	}

	async enterIap(ctx: LinkContext): Promise<IapSession | IapRefused> {
		const opening = ctx.port.open({ modes: ["iap"], reason: "enter-update-mode" }, ctx.signal);
		const early = await Promise.race([opening, Promise.resolve(null)]).then(
			() => null,
			(error: unknown) => ({ error }),
		);
		if (early !== null) {
			await this.close();
			throw early.error;
		}
		try {
			await transmit(this.ch, "resetToIap", {}, ctx.signal);
		} catch (error) {
			const boardMayHaveReset = error instanceof LinkLost || error instanceof LinkTimeout;
			if (!boardMayHaveReset) {
				opening.catch(() => undefined);
				await this.close();
				throw error;
			}
		}
		await this.close();
		return attach(await opening, ctx, "iap");
	}

	close(): Promise<void> {
		return this.ch.link.close();
	}
}

/**
 * What one update-mode session has done to flash, in the safety order: the version page erased, then the window,
 * then the image written, then a SUM of the image range. writeImage needs the window erased on this session, and
 * writeVersionBlock needs a SUM that matched the image. Each erase or write step starts by forgetting what came
 * before, so a step that throws leaves nothing to build on.
 */
type FlashProgress =
	| { readonly kind: "none" }
	| { readonly kind: "page-erased" }
	| { readonly kind: "window-erased" }
	| { readonly kind: "image-written" }
	| { readonly kind: "summed"; readonly bytes: number; readonly sum: Sum32 };

class Iap implements IapSession {
	readonly mode = "iap";
	#progress: FlashProgress = { kind: "none" };

	constructor(
		private readonly ch: Channel,
		readonly info: BlInfo,
		readonly window: FlashWindow,
	) {}

	readVersionPage(signal: AbortSignal): Promise<VersionPageRead> {
		return readVersionPage(this.ch, signal);
	}

	probe(signal: AbortSignal): Promise<void> {
		return probe(this.ch, signal);
	}

	async checksum(imageBytes: number, signal: AbortSignal): Promise<{ readonly sum: Sum32; readonly crc: Crc32 | null }> {
		const span = imageSpan(this.window, imageBytes);
		if (span === null) throw new RangeError(`an image of ${imageBytes} bytes does not fit the window`);
		const sum = sum32Literal(u32Of(await transmit(this.ch, "sum", { payload: rangePayload(span) }, signal)));
		this.#progress = { kind: "summed", bytes: imageBytes, sum };
		const crc = clears(this.ch.clearance, "crc") ? crc32Literal(u32Of(await transmit(this.ch, "crc", { payload: rangePayload(span) }, signal))) : null;
		return { sum, crc };
	}

	async eraseWindow(): Promise<void> {
		this.#progress = { kind: "none" };
		await transmit(this.ch, "erase", { payload: rangePayload(versionPage(this.window)) }, NEVER_ABORTED);
		this.#progress = { kind: "page-erased" };
		for (let tries = 1; tries <= TRIES; tries++) {
			try {
				await transmit(this.ch, "erase", { payload: rangePayload(appRegion(this.window)) }, NEVER_ABORTED);
				this.#progress = { kind: "window-erased" };
				return;
			} catch (error) {
				if (!(error instanceof DeviceRefused || error instanceof LinkTimeout)) throw error;
				await settle(this.ch);
				if (error instanceof DeviceRefused) break;
			}
		}
		await transmit(this.ch, "erase", { payload: rangePayload(wholeWindow(this.window)) }, NEVER_ABORTED);
		this.#progress = { kind: "window-erased" };
	}

	async writeImage(image: FlashableImage, onChunk: (done: number, total: number) => void): Promise<void> {
		const { bytes } = imageBytes(image).wire;
		const span = imageSpan(this.window, bytes.length);
		if (span === null) throw new RangeError(`an image of ${bytes.length} bytes does not fit the window`);
		if (this.#progress.kind !== "window-erased") throw new FlashOrderBroken(`writeImage after ${this.#progress.kind}, not after eraseWindow on this session`);
		this.#progress = { kind: "none" };
		await writeAt(this.ch, span, bytes, onChunk);
		this.#progress = { kind: "image-written" };
	}

	async writeVersionBlock(image: FlashableImage): Promise<void> {
		const { bytes } = imageBytes(image).versionBlock;
		const span = versionSpan(this.window);
		if (bytes.length !== span.length) throw new RangeError(`a version block of ${bytes.length} bytes, expected ${span.length}`);
		const { image: wanted } = image.entry;
		const done = this.#progress;
		if (done.kind !== "summed" || done.bytes !== wanted.bytes || done.sum !== wanted.wireSum32) {
			throw new FlashOrderBroken(`writeVersionBlock after ${done.kind === "summed" ? `a SUM of 0x${done.sum.toString(16)}` : done.kind}, not after a SUM matching ${image.entry.version}`);
		}
		this.#progress = { kind: "none" };
		await writeAt(this.ch, span, bytes, () => undefined);
		const back = (await readVersionPage(this.ch, NEVER_ABORTED)).bytes.subarray(0, span.length);
		if (back.some((byte, at) => byte !== bytes[at])) throw new ReadBackMismatch("the version page read back differs from the block written");
	}

	exitToApp(): Promise<void> {
		return restartToApp(this.ch);
	}

	close(): Promise<void> {
		return this.ch.link.close();
	}
}

async function inspect(ch: Channel, signal: AbortSignal): Promise<{ readonly info: BlInfo; readonly window: FlashWindow } | LayoutRefusal> {
	const { mode } = ch.link;
	const modeByte = await readModeByte(ch, signal);
	if (modeByte !== MODE_BYTE[mode]) return { code: "mode-disagrees", productIdSays: mode, readModeSays: modeByte };
	const info = parseBlInfo(payloadOf(await transmit(ch, "readBlInfo", {}, signal)));
	if ("code" in info) return info;
	if (mode === "iap") await transmit(ch, "readFwInfo", {}, signal);
	const window = windowFor(info);
	if ("code" in window) return window;
	return { info, window };
}

function refused(ch: Channel, refusal: LayoutRefusal): Refused {
	const close = () => ch.link.close();
	return ch.link.mode === "iap"
		? { mode: "iap", refusal, restartToApp: () => restartToApp(ch), close }
		: { mode: "app", refusal, restartToApp: null, close };
}

function attach(link: Link, ctx: LinkContext, as: "app"): Promise<AppSession | AppRefused>;
function attach(link: Link, ctx: LinkContext, as: "iap"): Promise<IapSession | IapRefused>;
function attach(link: Link, ctx: LinkContext, as: Mode): Promise<Session | Refused>;
async function attach(link: Link, ctx: LinkContext, as: Mode): Promise<Session | Refused> {
	if (link.mode !== as) {
		await link.close();
		throw new Error(`the port opened a ${link.mode} link for ${as}`);
	}
	const ch: Channel = { link, clock: ctx.port.clock, clearance: ctx.clearance, window: null, cursor: null };
	let seen: Awaited<ReturnType<typeof inspect>>;
	try {
		seen = await inspect(ch, ctx.signal);
	} catch (error) {
		if (link.mode === "iap") throw new IapAttachFailed(ch, error);
		await link.close();
		throw error;
	}
	if ("code" in seen) return refused(ch, seen);
	ch.window = seen.window;
	return link.mode === "app" ? new App(ch, seen.info, seen.window) : new Iap(ch, seen.info, seen.window);
}

interface SingleModeWant<M extends Mode> {
	readonly modes: readonly [M];
	readonly reason: WantReason;
}

/**
 * Opens a link for `want`, then proves the board is the one this tool knows before returning a typed session. When
 * that proof throws, a normal-mode link is closed and the error propagates, and an update-mode link stays open inside
 * an IapAttachFailed.
 */
export function connect(ctx: LinkContext, want: SingleModeWant<"app">): Promise<AppSession | AppRefused>;
export function connect(ctx: LinkContext, want: SingleModeWant<"iap">): Promise<IapSession | IapRefused>;
export function connect(ctx: LinkContext, want: DeviceWant): Promise<Session | Refused>;
export async function connect(ctx: LinkContext, want: DeviceWant): Promise<Session | Refused> {
	const link = await ctx.port.open(want, ctx.signal);
	if (!want.modes.includes(link.mode)) {
		await link.close();
		throw new Error(`the port opened a ${link.mode} link for ${want.modes.join(" or ")}`);
	}
	return attach(link, ctx, link.mode);
}
