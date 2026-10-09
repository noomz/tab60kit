/**
 * Talking to the CYKB firmware on the vendor interface: the command registry, the single path to the wire,
 * and one session type per mode. Internal to the core. Nothing outside the package can import it.
 *
 * Every byte the tool sends leaves through `transmit`, which encodes a request and then audits the exact 64 bytes
 * before the link sees them. The audit does not trust the encoder. It decodes the frame the way the board will and
 * checks it against four things, each owned in one place:
 *   - The registry. COMMANDS lists every (cmd, sub) the tool may send. Any other pair is refused.
 *   - G1, per command. A shipped kit sends only rows whose evidence maturity is "confirmed". A lab kit sends exactly
 *     the commands its clearance names, each at least "reviewed".
 *   - Mode. A command the current firmware does not implement is refused. The session types also make the wrong call
 *     hard to write: flash operations exist only on IapSession.
 *   - The window. Every address the frame carries, and the write cursor a WRITE lands on, must lie inside the window
 *     validated at attach. Erases must be page-aligned.
 * Only the audit makes an `OutReport`, the one type `Link.send` accepts.
 */
import { EXPECTED_LAYOUT, TAB60 } from "./device";
import type { FlashableImage } from "./firmware";
import { type BlInfo, type FlashWindow, type LayoutRefusal, inWindow } from "./flashmap";
import type { KeyId, KeyWrite, Layer, OsMode, Usage } from "./keymap";
import type { DevicePort, DeviceWant, InReport, Link, OutReport } from "./port";
import { type Crc32, type Mode, type Sum32, notImplemented } from "./units";

/** What a command does to the board. The gate and the UI read this, never the opcode. */
export type Effect = "read" | "reboot" | "erase" | "write" | "sram-write";

/**
 * Where the command is known from. The user's G1 ruling allows, after review, "the commands the vendor updater
 * itself sends". So "vendor-updater" is the only source that can carry an erase or write row above "unreviewed".
 */
export type Evidence =
	| { readonly source: "vendor-updater"; readonly at: string }
	| { readonly source: "pok3rtool"; readonly at: string }
	| { readonly source: "app-disassembly"; readonly at: string };

/**
 * G1 as evidence maturity, per command (candidate A's ladder). A row moves up only in a reviewed commit:
 *   unreviewed -> reviewed    the user reviewed the row. A lab clearance that names it may send it.
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
 * Where a frame carries flash addresses, so the audit decodes them the way the board will (R1 "Packet framing").
 *   none         no address
 *   range        u32 offset at byte 4, u32 length at byte 8 (ERASE, SUM, CRC)
 *   set-cursor   u32 offset at byte 4 becomes the board's write cursor (set write address)
 *   at-cursor    the payload lands at the write cursor, and the sub byte is its length (WRITE)
 */
export type Addressing = "none" | "range" | "set-cursor" | "at-cursor";

/** Sub-commands `first` to `first + count - 1`. Part i of a request is sub `first + i`. */
export interface SubRange {
	readonly first: number;
	readonly count: number;
}

export interface CommandSpec {
	readonly label: string;
	readonly cmd: number;
	/** A fixed sub, a range of parts, or "length" for WRITE, whose sub byte is the payload length (1 to 52). */
	readonly sub: number | SubRange | "length";
	readonly modes: readonly Mode[];
	readonly effect: Effect;
	/** echo: bytes 0..1 repeat cmd and sub. write-ack: 0x1E 0x02 then the u32 next offset. none: the board resets instead. */
	readonly reply: "echo" | "write-ack" | "none";
	readonly timeoutMs: number;
	readonly address: Addressing;
	/** The editor capability this command is part of. keymap.ts derives its locks from this field. */
	readonly unlocks: "keymap-read" | "keymap-write" | "os-mode" | null;
	readonly evidence: Evidence;
	readonly maturity: Maturity;
}

const UNREVIEWED = { level: "unreviewed" } as const;

/**
 * Every command the tool can send. Commands the design does not use (PING, DISCONNECT, get write address,
 * and the patched-firmware READ 0xFF) are left out on purpose, so the audit refuses them. Today every row is
 * unreviewed, so G1 forbids every output report until the user reviews rows and a lab session captures them
 * (docs/units.md U1, U7, U10, U11).
 */
export const COMMANDS = {
	readBlInfo: {
		label: "Read bootloader info",
		cmd: 0x12,
		sub: 0x00,
		modes: ["app", "iap"],
		effect: "read",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: null,
		evidence: { source: "vendor-updater", at: "R2 0x404E80 identity compare reads 16 bytes (command INFERRED, U2)" },
		maturity: UNREVIEWED,
	},
	readFwInfo: {
		label: "Read firmware info",
		cmd: 0x12,
		sub: 0x01,
		modes: ["iap"],
		effect: "read",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: null,
		evidence: { source: "vendor-updater", at: "R2 0x4051B2 takes the write address from FW info" },
		maturity: UNREVIEWED,
	},
	readMode: {
		label: "Read mode",
		cmd: 0x12,
		sub: 0x02,
		modes: ["app", "iap"],
		effect: "read",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: null,
		evidence: { source: "pok3rtool", at: "cykb.py:132-135; R4 app handler 0x767A" },
		maturity: UNREVIEWED,
	},
	readVersionPage: {
		label: "Read version page",
		cmd: 0x12,
		/** The board serves parts 0 to 7, 60 bytes each from absolute 0x3000 + 60 * i (R4 0x7620, VERIFIED). The tool reads the 180-byte block, parts 0 to 2. */
		sub: { first: 0x20, count: 3 },
		modes: ["app", "iap"],
		effect: "read",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: null,
		evidence: { source: "vendor-updater", at: "R2 0x405789..0x405879 version block read-back; R1 proto_cykb.cpp:116-121 reads parts 0..2" },
		maturity: UNREVIEWED,
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
		unlocks: null,
		evidence: { source: "vendor-updater", at: "board re-enumerated during the vendor flash; exact call site U2" },
		maturity: UNREVIEWED,
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
		unlocks: null,
		evidence: { source: "vendor-updater", at: "board returned as 0x0304 after the vendor flash; exact call site U2" },
		maturity: UNREVIEWED,
	},
	erase: {
		label: "Erase pages",
		cmd: 0x1d,
		sub: 0x00,
		modes: ["iap"],
		effect: "erase",
		reply: "echo",
		timeoutMs: 15_000,
		address: "range",
		unlocks: null,
		evidence: { source: "vendor-updater", at: 'R2 0x404FE0 flash routine, "Fail to Erase Flash!"' },
		maturity: UNREVIEWED,
	},
	sum: {
		label: "Sum of a range",
		cmd: 0x1d,
		sub: 0x01,
		modes: ["iap"],
		effect: "read",
		reply: "echo",
		timeoutMs: 2_000,
		address: "range",
		unlocks: null,
		evidence: { source: "vendor-updater", at: "R2 0x408780 asks the board for its sum" },
		maturity: UNREVIEWED,
	},
	crc: {
		label: "CRC-32 of a range",
		cmd: 0x1d,
		sub: 0x02,
		modes: ["iap"],
		effect: "read",
		reply: "echo",
		timeoutMs: 2_000,
		address: "range",
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
		reply: "echo",
		timeoutMs: 500,
		address: "set-cursor",
		unlocks: null,
		evidence: { source: "vendor-updater", at: "R2 calls to 0x404F60 at 0x405538 and 0x4051B2" },
		maturity: UNREVIEWED,
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
		unlocks: null,
		evidence: { source: "vendor-updater", at: "R2 0x40511F and 0x405204, write_block_size 52" },
		maturity: UNREVIEWED,
	},
	cfgReadReverseMap: {
		label: "Read reverse keymap (cmd 0x51/0x11)",
		cmd: 0x51,
		sub: 0x11,
		modes: ["app"],
		effect: "read",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: "keymap-read",
		evidence: { source: "app-disassembly", at: "R4 sub_7B90 case 0x51 at 0x7EB2; format INFERRED" },
		maturity: UNREVIEWED,
	},
	cfgSelectLayer: {
		label: "Select layer (cmd 0x51/0x30)",
		cmd: 0x51,
		sub: 0x30,
		modes: ["app"],
		effect: "sram-write",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: "keymap-write",
		evidence: { source: "app-disassembly", at: "R4 0x7EB2, index < 4; format INFERRED" },
		maturity: UNREVIEWED,
	},
	cfgSetKey: {
		label: "Set key (cmd 0x51/0xA8)",
		cmd: 0x51,
		sub: 0xa8,
		modes: ["app"],
		effect: "sram-write",
		reply: "echo",
		timeoutMs: 500,
		address: "none",
		unlocks: "keymap-write",
		evidence: { source: "app-disassembly", at: "R4 0x7EB2, per-layer per-key entry at 0x20000750; format INFERRED" },
		maturity: UNREVIEWED,
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
		unlocks: "os-mode",
		evidence: { source: "app-disassembly", at: "R4 0x7EF2 cmp r7,#5 then strb to 0x2000000F" },
		maturity: UNREVIEWED,
	},
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

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
 * so the user's review lands in a commit before the first packet. The session's transcript is the capture that
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

/** Why the egress audit refused a frame. Every code but "not-cleared" means a bug in the core. */
export type EgressRefusal =
	| { readonly code: "bad-length"; readonly bytes: number }
	| { readonly code: "unknown-command"; readonly cmd: number; readonly sub: number }
	| { readonly code: "not-requested"; readonly decoded: CommandName; readonly requested: CommandName }
	| { readonly code: "not-cleared"; readonly command: CommandName }
	| { readonly code: "wrong-mode"; readonly command: CommandName; readonly mode: Mode }
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
 * The egress audit (candidate A, merged into the one write path). Pure. Decodes the exact bytes about to leave, with
 * no help from the encoder, and checks them against the registry, the clearance, the mode, and the window.
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
	readonly clearance: Clearance;
	/** Set once by attach after BL info validates. */
	window: FlashWindow | null;
	/** Moved only by transmit, after the board acknowledged an audited set-address or WRITE. */
	cursor: number | null;
}

/** What a request adds to its command: the part of a range command, and the payload. */
interface Request {
	readonly part?: number;
	readonly payload?: Uint8Array;
}

/**
 * Builds the 64 bytes for a request. Nothing trusts its output: transmit audits every frame it builds.
 * TODO: spec = COMMANDS[name]
 *   byte 0 = cmd; byte 1 = the fixed sub, or first + part for a range (part < count), or the payload length for WRITE
 *   bytes 2..3 = the value the vendor updater sends (pok3rtool sends 0; U2 reads the vendor's)
 *   payload from byte 4; zero padding to 64
 */
function encode(name: CommandName, request: Request): Uint8Array {
	return notImplemented(`encode(${name}, part ${String(request.part)}, ${request.payload?.length ?? 0} bytes)`);
}

/**
 * The single path from the core to the wire.
 * TODO:
 *   frame = encode(name, request)
 *   verdict = auditEgress(frame, name, { mode: ch.link.mode, window: ch.window, cursor: ch.cursor,
 *                                        cleared: (command) => clears(ch.clearance, command) })
 *   refused "not-cleared" -> throw NotCleared(name, ch.clearance)          G1: nothing sent
 *   refused, any other code -> throw ProtocolInvariantBroken(refusal)      a core bug: nothing sent
 *   ch.link.discardPending()                                               a late reply must not pair with this request
 *   await ch.link.send(verdict.frame)
 *   if spec.reply === "none" -> return null                                the board resets; the caller expects LinkLost next
 *   loop until spec.timeoutMs elapses:
 *     reply = await ch.link.next(remaining)
 *     FF AA in bytes 0..1 -> if the command moves the cursor, ch.cursor = null; throw DeviceRefused(name, u16 at 4)
 *     echo matches, or WRITE and 1E 02 with next offset === verdict.cursor -> ch.cursor = verdict.cursor; return reply
 *     WRITE ack with any other next offset -> ch.cursor = null; throw DeviceRefused(name, next offset)
 *     anything else is stale: drop it and keep waiting
 */
async function transmit(ch: Channel, name: CommandName, request: Request): Promise<InReport | null> {
	return notImplemented(
		`transmit(${ch.link.mode}, ${name}) via ${encode.name} and ${auditEgress.name}, window ${String(ch.window?.end)}, part ${String(request.part)}`,
	);
}

/** The 180-byte version page: parts 0, 1, and 2 of READ VERSION PAGE, 60 bytes each from absolute 0x3000 + 60 * i. */
export interface VersionPageRead {
	readonly bytes: Uint8Array;
}

/** The live config channel (app mode). Every method throws NotCleared until U10 and U11 lift G1 for it. */
export interface ConfigChannel {
	/** One layer as the board holds it now. The read command and format are INFERRED; U10 settles them. */
	readLayer(layer: Layer): Promise<ReadonlyMap<KeyId, Usage>>;
	setKey(write: KeyWrite): Promise<void>;
	setOsMode(mode: OsMode): Promise<void>;
}

/** What opening a session needs: where links come from, what G1 lets this kit send, and the job's cancel signal. */
export interface LinkContext {
	readonly port: DevicePort;
	readonly clearance: Clearance;
	readonly signal: AbortSignal;
}

/**
 * Normal mode. Reads, the live config channel, and the restart into update mode.
 * Nothing on this type can address flash, and the app firmware has no flash-write code anyway (R4).
 */
export interface AppSession {
	readonly mode: "app";
	readonly info: BlInfo;
	readonly window: FlashWindow;
	readVersionPage(): Promise<VersionPageRead>;
	/**
	 * Restarts the board into update mode and returns the bootloader session. This session is closed afterwards.
	 * TODO, the order matters in a browser:
	 *   opening = ctx.port.open({ modes: ["iap"], reason: "enter-update-mode" }, ctx.signal)   start first, do not await:
	 *     a chooser opened inside the click's activation stays open and adds the row when the bootloader appears (R3 C7)
	 *   await transmit(ch, "resetToIap", {})                                                   no reply; the app link dies
	 *   await this.close()
	 *   iapLink = await opening
	 *   return attach(iapLink, ctx.clearance)                                                  same checks as connect()
	 */
	enterIap(ctx: LinkContext): Promise<IapSession>;
	readonly config: ConfigChannel;
	close(): Promise<void>;
}

/** Update mode. Every flash operation addresses the window validated at attach; none takes an address. */
export interface IapSession {
	readonly mode: "iap";
	readonly info: BlInfo;
	readonly window: FlashWindow;
	readVersionPage(): Promise<VersionPageRead>;
	/** READ MODE as a liveness probe for the link gate (flash.ts). Resolves when the board answers 0, update mode. */
	probe(): Promise<void>;
	/** SUM, plus CRC-32 when cleared, over [imageBase, imageBase + imageBytes). */
	checksum(imageBytes: number): Promise<{ readonly sum: Sum32; readonly crc: Crc32 | null }>;
	/**
	 * ERASE the version page (`versionPage(window)`), wait for its echo, then ERASE the app region (`appRegion(window)`).
	 * The page is gone before any app byte changes, whatever order the IAP erases pages within one command, so no
	 * interruption leaves a valid page over a damaged image (legacy pok3rtool's order, R1; candidate A). These are the
	 * only erases the tool sends.
	 */
	eraseWindow(): Promise<void>;
	/**
	 * Sets the write address to the image offset, then sends WRITE in 52-byte chunks of `imageBytes(image).wire`.
	 * Each ack must report next offset = cursor + chunk length; anything else throws DeviceRefused and the caller's
	 * next observation decides what happens.
	 */
	writeImage(image: FlashableImage, onChunk: (done: number, total: number) => void): Promise<void>;
	/**
	 * Sets the write address to 0 and writes `imageBytes(image).versionBlock`, 180 bytes, as chunks of 52, 52, 52, and
	 * 24. The 0x5AA5 magic at offset 0xB0 sits in the last chunk, so a partial block never carries it. Then reads the
	 * page back and compares, as the vendor updater does.
	 */
	writeVersionBlock(image: FlashableImage): Promise<void>;
	/** Restarts into normal mode. The session is closed afterwards; the board re-enumerates as 0x0304. */
	exitToApp(): Promise<void>;
	close(): Promise<void>;
}

export type Session = AppSession | IapSession;

/**
 * Opens a link for `want`, then proves the board is the one this tool knows before returning a typed session.
 * TODO (shared with enterIap through an internal `attach(link, clearance)`):
 *   link = await ctx.port.open(want, ctx.signal); ch = { link, clearance: ctx.clearance, window: null, cursor: null }
 *   mode byte = READ MODE; refuse mode-disagrees unless it matches link.mode (0 = iap, 1 = app)
 *   info = parseBlInfo(READ BL INFO payload)
 *   fwInfo = link.mode === "iap" ? u16 of READ FW INFO : null
 *   ch.window = windowFor(info, fwInfo)
 *   on any refusal: close the link and return the refusal. A refused board never receives an addressed command.
 */
export async function connect(ctx: LinkContext, want: DeviceWant): Promise<Session | LayoutRefusal> {
	return notImplemented(
		`connect(${want.modes.join("|")}, ${want.reason}, ${ctx.clearance.kind}, aborted=${ctx.signal.aborted}) to ${TAB60.productName.app}, chunks of ${EXPECTED_LAYOUT.writeChunkBytes}, via ${transmit.name}`,
	);
}
