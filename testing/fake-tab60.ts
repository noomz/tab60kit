/**
 * A behavioral model of the TAB 60 on the vendor interface, for tests. It is the protocol in docs/protocol.md, the app command
 * map, override store, and gate in docs/app-firmware.md, in executable form. Every behavior
 * it models is INFERRED until a hardware transcript (U1, U7, U10) confirms it; when the two disagree, the transcript
 * wins and this file changes.
 *
 * It must not import the host codec. It implements the tables in docs/protocol.md and docs/app-firmware.md with its
 * own byte handling, so a codec bug in the core and the same bug in the fake cannot cancel out. probes/boundaries.ts
 * fails the build when this file's imports reach core/ anywhere but port.ts, the seam it implements, and units.ts.
 * The facts it checks against (the target image's length and wire sum) come in through FakeOptions from the test.
 *
 * It also records violations: anything a real board might accept that this tool must never send.
 */
import type { Clock, DevicePort, InReport, Link, Mode, OutReport } from "../core/port";
import { LinkLost, LinkTimeout, ReportQueue, asInReport } from "../core/port";
import { type Sha256, sha256Literal } from "../core/units";

export interface FakeOptions {
	/** What the board holds at the start of the test. */
	readonly starting:
		| "official-image"
		| "update-mode-official-image"
		| "untrusted-image"
		| "update-mode-erased"
		| "update-mode-partial-version-block"
		/** A valid version page over an image that fails its sum, in update mode: the "boots-damaged-image" case. */
		| "update-mode-damaged-image";
	/** The image a correct run ends with, from the catalog entry the test flashes. */
	readonly target: { readonly imageBytes: number; readonly wireSum32: number };
	/**
	 * Lose the link right before the board would receive this output report (counted from 0 across the run). The
	 * board then re-enumerates in the same mode, as after a USB glitch.
	 */
	readonly loseLinkAtPacket?: number;
	/**
	 * Execute this output report, then lose the link before its reply leaves: the board did the work and the host
	 * never heard. Counted like `loseLinkAtPacket`.
	 */
	readonly loseLinkAfterPacket?: number;
	/** On that loss, also reset the MCU: SRAM is cleared and the IAP decides from the version page. */
	readonly resetOnLoss?: boolean;
	/** The board answers this command with the FF AA error marker once. */
	readonly refuseOnce?: { readonly cmd: number; readonly sub: number };
	/** The board answers this command with the FF AA error marker every time, and does not execute it. */
	readonly refuseAlways?: { readonly cmd: number; readonly sub: number };
	/** The board answers this command in this mode `ms` late, once, after answering `skip` (default 0) earlier ones on time. */
	readonly slowOnce?: { readonly cmd: number; readonly sub: number; readonly mode: Mode; readonly ms: number; readonly skip?: number };
	readonly blInfo?: Uint8Array;
	readonly blInfoInIap?: Uint8Array;
	readonly versionBlock?: Uint8Array;
	/** A delay keeps a chooser opened by the reset's click on screen before the bootloader row appears, as on a real board. */
	readonly reenumerateAfterMs?: number;
	/**
	 * "virtual" moves time only when something waits: a sleep returns at once, and a late or missing answer advances
	 * the clock to the reply or to the request's timeout. The drop sweep runs the 15 s link gate this way. Default "real".
	 */
	readonly clock?: "real" | "virtual";
	/** The order the IAP erases the pages of one ERASE, which docs/protocol.md does not document. Default "descending", the order that punishes one ERASE over the whole window. */
	readonly eraseOrder?: "descending" | "ascending";
	/**
	 * An IAP that takes only the vendor's erases, which all start at offset 0 (U2): an ERASE at any other
	 * offset gets the FF AA marker naming 1D 00, or no answer, and erases nothing. Default: it takes any aligned range.
	 */
	readonly offsetErase?: "error-marker" | "silent";
	/**
	 * WRITE frames `at` to `at + times - 1`, counted from 0 across the run, go wrong: "no-reply" is never received,
	 * "mute" is executed with its ack lost, and "wrong-next" is executed and acked with a next offset one word too far.
	 */
	readonly writeFault?: { readonly at: number; readonly times: number; readonly kind: "no-reply" | "mute" | "wrong-next" };
	/** Get write address answers `at` to `at + times - 1`, counted from 0, report the cursor one word too far. */
	readonly cursorFault?: { readonly at: number; readonly times: number };
	/** SRAM 0x2000102B, the OS key mode the active keymap is built for: 0x10 (default), 0x20, or 0x40. */
	readonly osKeyMode?: 0x10 | 0x20 | 0x40;
	/** Entries of the key override store, by layer and matrix cell, written over the store the reset leaves (0xFF, plus the factory layer 2). */
	readonly overrides?: readonly { readonly layer: 0 | 1 | 2; readonly cell: number; readonly usage: number; readonly flags: 0 | 1 | 2 | 3 }[];
}

export type Violation =
	/** ERASE, SUM, CRC, set-address, or WRITE that touches [0x0, 0x3000) or [0x1FE00, ...), or wraps 32 bits. */
	| { readonly kind: "outside-window"; readonly cmd: number; readonly offset: number; readonly length: number }
	/** The version block's magic written while the image range did not sum to the target's wire sum. */
	| { readonly kind: "version-block-before-verified-image" }
	/** An app page changed while the version page still held its magic: a reset right then would boot a damaged image. */
	| { readonly kind: "app-changed-under-valid-page"; readonly page: number }
	/** A config command (0x40 and up) sent during a flash job, or any command in a mode that lacks it. */
	| { readonly kind: "wrong-mode"; readonly cmd: number; readonly sub: number; readonly mode: Mode }
	/** An update-mode command this fake does not model: CRC, which no clearance sends yet. */
	| { readonly kind: "not-modeled"; readonly cmd: number; readonly sub: number }
	/** A frame the maintainer's U11 ruling forbids: a gate byte other than 0x00, 0x80, or 0xFF, or a key write with flags set. */
	| { readonly kind: "unsafe-config"; readonly cmd: number; readonly sub: number; readonly value: number };

/** One output report the board received, stamped with the fake's clock. */
export interface Received {
	readonly t: number;
	readonly cmd: number;
	readonly sub: number;
	readonly mode: Mode;
	/** The u32s at bytes 4 and 8: an ERASE's or SUM's offset and length, or the address a set write address names. */
	readonly words: readonly [number, number];
}

const REPORT_BYTES = 64;
const PAYLOAD_OFFSET = 4;
const PAYLOAD_BYTES = REPORT_BYTES - PAYLOAD_OFFSET;
const FLASH_BYTES = 0x20000;
const BL_INFO_ADDR = 0x400;
const BL_INFO_BYTES = 52;
const PROTOCOL_BASE = 0x3000;
const PAGE_SIZE = 0x200;
const FW_OFFSET = 0x200;
const FW_PAGES = 0xe7;
const WINDOW_BYTES = FW_PAGES * PAGE_SIZE;
const FW_INFO = Uint8Array.of(0x04, 0x00, 0x02, 0x00);
export const VERSION_BLOCK_BYTES = 180;
const VERSION_PAGE_PARTS_APP = 8;
const VERSION_PAGE_PARTS_IAP = 3;
const MAGIC_OFFSET = 0xb0;
const MAGIC = 0x5aa5;
const FIXED_WORDS_OFFSET = 0x78;
const WRITE_CHUNK_BYTES = 52;
/** The 80-byte matrix keymap at ROM 0xB205 of V1.01.13, which boot copies to SRAM 0x20000590 (sub_5314). */
const ROM_KEYMAP = Uint8Array.from(
	["291e2b143904e11d1f201a0816071b06", "21221517090a190523241c180b0d1110", "25260c120e0f3637272d132f333438e5", "2e2a30312832650000350000e70000e4", "00000000000000642c00e3e0e200e6c9"].join("").match(/../g) ?? [],
	(byte) => parseInt(byte, 16),
);
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
/** The (usage, code) pairs at ROM 0xB2D6 that sub_4540 writes to layer 2 with flags 1 after the reset clears the store. */
const FACTORY_LAYER2 = hexBytes("29701ea01fa120a22182228326ac27ad2da82ea9e2302b3531360d310e320f3333341110101136123713e05fe568e360143d1a3e083f049216931d901b91");
const FACTORY_FLAGS = 1;
/** The usage swaps sub_5F4C applies per OS key mode: ROM 0xAA25 for 0x20, ROM 0xAA21 for 0x40. */
const KEY_MODE_SWAPS: Readonly<Record<0x10 | 0x20 | 0x40, Uint8Array>> = { 0x10: hexBytes(""), 0x20: hexBytes("e2e3e3e2e6e7e7e6"), 0x40: hexBytes("39e0e039") };
/** sub_5F4C writes the Fn and Pn markers into the cells SRAM 0x20000E50/51 name, 0x3C and 0x36 by default. */
const MARKERS: readonly [cell: number, usage: number][] = [
	[0x3c, 0xd8],
	[0x36, 0xd9],
];
const KEY_CELLS = 80;
const KEY_LAYERS = 3;
const NO_OVERRIDE = 0xff;
/** What sub_5E98 returns for a usage no cell holds; the 0x52 handler sends 0x0003 in its place. */
const NO_SUCH_KEY = 0x01ff;
const ABSENT = 0x0003;
/** cmd 0x41: byte 1 0xFF queries; any other value becomes the gate byte at 0x200006FA. */
const GATE_QUERY = 0xff;
const SAFE_GATES: readonly number[] = [0x00, 0x80];
/** Gate bits: cmd 0x51 runs only under 0x81; bit 0 is config mode, whose exit reloads the saved store; bit 6 drops replies. */
const GATE_OPEN_MASK = 0x81;
const GATE_CONFIG_MODE = 0x01;
const GATE_SILENT = 0x40;
/** sub_5E98's bounds on a write: the index at 0x2FF, the value at 0x3FF and never 3. */
const MAX_KEY_INDEX = 0x2ff;
const MAX_KEY_VALUE = 0x3ff;

/** Virtual time each command costs, and each erased page on top: rough, so gaps and waits are not all zero. */
const COMMAND_MS = 1;
const ERASE_PAGE_MS = 10;

/** sub_91EC: usage to the lowest cell holding it, 0xFF for none. */
function reverseOf(active: Uint8Array): Uint8Array {
	const reverse = new Uint8Array(256).fill(0xff);
	for (let cell = KEY_CELLS - 1; cell >= 0; cell--) reverse[active[cell]!] = cell;
	return reverse;
}

/** sub_5314, then sub_5F4C: the ROM keymap, the mode's swaps looked up in the reverse map of the ROM keymap, then the markers. */
function activeKeymap(mode: 0x10 | 0x20 | 0x40): Uint8Array {
	const active = Uint8Array.from(ROM_KEYMAP);
	const before = reverseOf(ROM_KEYMAP);
	const swaps = KEY_MODE_SWAPS[mode];
	for (let i = 0; i < swaps.length; i += 2) {
		const cell = before[swaps[i]!]!;
		if (cell !== 0xff) active[cell] = swaps[i + 1]!;
	}
	for (const [cell, marker] of MARKERS) active[cell] = marker;
	return active;
}

export function blInfoBlock(fields: { readonly fwOffset?: number; readonly fwPages?: number; readonly pageSize?: number; readonly bootPid?: number } = {}): Uint8Array {
	const block = new Uint8Array(BL_INFO_BYTES);
	const view = new DataView(block.buffer);
	view.setUint32(0x00, 0x4, true);
	view.setUint32(0x04, 0x0, true);
	view.setUint16(0x08, 0x04d9, true);
	view.setUint16(0x0a, fields.bootPid ?? 0x1304, true);
	view.setUint16(0x0c, 0x7040, true);
	view.setUint16(0x0e, 0x0404, true);
	view.setUint32(0x10, 0xffffffff, true);
	view.setUint32(0x14, 0x1, true);
	view.setUint32(0x18, 0xffffffff, true);
	view.setUint32(0x1c, 0x106, true);
	view.setUint16(0x20, fields.fwOffset ?? FW_OFFSET, true);
	view.setUint16(0x22, fields.fwPages ?? FW_PAGES, true);
	view.setUint16(0x24, fields.pageSize ?? PAGE_SIZE, true);
	block.set(Array.from("KB0304", (c) => c.charCodeAt(0)), 0x26);
	view.setUint32(0x30, 0xffffffff, true);
	return block;
}

export function syntheticVersionBlock(version = "V1.01.13"): Uint8Array {
	const block = new Uint8Array(VERSION_BLOCK_BYTES).fill(0xff);
	const view = new DataView(block.buffer);
	view.setUint32(0, 0x1a, true);
	block.set(new Uint8Array(26), 4);
	block.set(Array.from(version, (c) => c.charCodeAt(0)).flatMap((b) => [b, 0]), 4);
	view.setUint32(FIXED_WORDS_OFFSET, 0x00800004, true);
	view.setUint32(0x7c, 0x4, true);
	view.setUint32(0x80, 0x142, true);
	view.setUint32(0x84, 0xefffffff, true);
	view.setUint32(0x88, 0x1, true);
	view.setUint32(0x8c, 0x0, true);
	view.setUint16(0x90, 0x04d9, true);
	view.setUint16(0x92, 0x0304, true);
	view.setUint32(MAGIC_OFFSET, 0x00ff0000 | MAGIC, true);
	return block;
}

export function bytesSummingTo(length: number, sum: number): Uint8Array {
	if (length % 4 !== 0 || length < 4) throw new RangeError(`image length ${length} is not whole words`);
	const bytes = new Uint8Array(length);
	new DataView(bytes.buffer).setUint32(0, sum >>> 0, true);
	return bytes;
}

export interface Plug {
	send(bytes: Uint8Array): void;
	unplug(): void;
}

export interface Socket {
	readonly report: (bytes: Uint8Array) => void;
	readonly detached: () => void;
	/** A virtual-clock link takes answers that come `ms` late (Infinity: never) here, and decides between reply and timeout. */
	readonly late?: (ms: number, deliver: () => void) => void;
}

const realClock: Clock = {
	now: () => performance.now(),
	sleep: (ms, signal) =>
		new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const onAbort = () => {
				clearTimeout(timer);
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			}, ms);
			signal.addEventListener("abort", onAbort, { once: true });
		}),
};

/** Time that moves only when the fake or a sleep moves it. */
export class VirtualClock implements Clock {
	#now = 0;

	now(): number {
		return this.#now;
	}

	advance(ms: number): void {
		this.#now += ms;
	}

	async sleep(ms: number, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		this.#now += ms;
	}
}

async function sha256Of(bytes: Uint8Array): Promise<Sha256> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
	return sha256Literal(Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""));
}

export class FakeTab60 {
	#mode: Mode;
	/** False between a detach and the re-enumeration that follows it: the host sees no device. */
	#present = true;
	/** Only the latest scheduled re-enumeration happens; a second detach supersedes the first. */
	#generation = 0;
	readonly #flash = new Uint8Array(FLASH_BYTES).fill(0xff);
	readonly #sockets = new Set<Socket>();
	readonly #arrivals: { readonly modes: readonly Mode[]; readonly resolve: () => void }[] = [];
	readonly #enumerationListeners = new Set<(mode: Mode) => void>();
	#refuseOnce: { readonly cmd: number; readonly sub: number } | null;
	#slowOnce: NonNullable<FakeOptions["slowOnce"]> | null;
	#slowSkip: number;
	#packets = 0;
	#writes = 0;
	#cursorReads = 0;
	/** The IAP's write address, a window offset, held in SRAM until the next MCU reset. */
	#cursor: number | null = null;
	/** The override store at SRAM 0x20000D24: usage byte per cell for layers 0..2, and the two flag bits per cell (unpacked). */
	readonly #overrides = new Uint8Array(KEY_LAYERS * KEY_CELLS).fill(NO_OVERRIDE);
	readonly #overrideFlags = new Uint8Array(KEY_LAYERS * KEY_CELLS);
	/** The store as the profile block on SPI flash holds it, which boot loads into SRAM. No host frame this fake models saves. */
	readonly #savedOverrides: Uint8Array;
	readonly #savedFlags: Uint8Array;
	/** The gate byte 0x200006FA and the u16 timer 0x200006F8, zero at boot. The fake never counts the timer down. */
	#gate = 0;
	#gateTimer = 0;
	/** The active keymap at SRAM 0x20000590 for the board's OS key mode. */
	readonly #active: Uint8Array;
	/** The reverse map at 0x200005E0 that sub_91EC builds from the active keymap: usage to the lowest cell holding it, 0xFF for none. */
	readonly #reverse: Uint8Array;
	readonly #violations: Violation[] = [];
	readonly #received: Received[] = [];
	readonly clock: Clock;
	ignoreInIap = false;

	constructor(readonly options: FakeOptions) {
		const { starting, target } = options;
		this.#refuseOnce = options.refuseOnce ?? null;
		this.#slowOnce = options.slowOnce ?? null;
		this.#slowSkip = options.slowOnce?.skip ?? 0;
		this.clock = options.clock === "virtual" ? new VirtualClock() : realClock;
		this.#flash.set(options.blInfo ?? blInfoBlock(), BL_INFO_ADDR);
		// sub_4540 writes the factory pairs by cell under mode 0x10; the board then runs in its saved mode.
		const atReset = reverseOf(activeKeymap(0x10));
		for (let i = 0; i < FACTORY_LAYER2.length; i += 2) {
			const cell = atReset[FACTORY_LAYER2[i]!]!;
			if (cell === 0xff) continue;
			this.#overrides[2 * KEY_CELLS + cell] = FACTORY_LAYER2[i + 1]!;
			this.#overrideFlags[2 * KEY_CELLS + cell] = FACTORY_FLAGS;
		}
		this.#active = activeKeymap(options.osKeyMode ?? 0x10);
		this.#reverse = reverseOf(this.#active);
		for (const { layer, cell, usage, flags } of options.overrides ?? []) {
			this.#overrides[layer * KEY_CELLS + cell] = usage;
			this.#overrideFlags[layer * KEY_CELLS + cell] = flags;
		}
		this.#savedOverrides = this.#overrides.slice();
		this.#savedFlags = this.#overrideFlags.slice();
		const page = options.versionBlock ?? syntheticVersionBlock();
		const official = bytesSummingTo(target.imageBytes, target.wireSum32);
		const untrusted = bytesSummingTo(target.imageBytes, target.wireSum32 + 1);
		this.#mode = starting === "official-image" || starting === "untrusted-image" ? "app" : "iap";
		switch (starting) {
			case "official-image":
			case "update-mode-official-image":
				this.#flash.set(page, PROTOCOL_BASE);
				this.#flash.set(official, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "untrusted-image":
				this.#flash.set(syntheticVersionBlock("V0.00.00"), PROTOCOL_BASE);
				this.#flash.set(untrusted, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "update-mode-erased":
				this.#flash.set(official, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "update-mode-partial-version-block":
				this.#flash.set(page.subarray(0, 52), PROTOCOL_BASE);
				this.#flash.set(official, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "update-mode-damaged-image":
				this.#flash.set(page, PROTOCOL_BASE);
				this.#flash.set(untrusted, PROTOCOL_BASE + FW_OFFSET);
				break;
			default: {
				const exhaustive: never = starting;
				throw new Error(String(exhaustive));
			}
		}
	}

	get mode(): Mode {
		return this.#mode;
	}

	get violations(): readonly Violation[] {
		return this.#violations;
	}

	/** Output reports received so far. The drop sweep runs once clean to learn the count. */
	get packetsReceived(): number {
		return this.#packets;
	}

	get received(): readonly Received[] {
		return this.#received;
	}

	/** USB unplugged with no batteries in, then plugged back: SRAM is gone, and boot loads the saved store with the gate closed. */
	powerCycle(): void {
		this.#reset(this.#bootMode());
	}

	/**
	 * The usage a press of matrix cell `cell` on the base layer sends (sub_505C, sub_6FE4): a flags-0 override the RAM
	 * store holds, else the active keymap's usage. null for an override with flags set, which is a function code or a
	 * dead key.
	 */
	baseLayerPress(cell: number): number | null {
		const byte = this.#overrides[cell]!;
		if (byte === NO_OVERRIDE) return this.#active[cell]!;
		return this.#overrideFlags[cell] === 0 ? byte : null;
	}

	/** Where the board would go on its next reset, and what its 180-byte version block holds. */
	async bootTarget(): Promise<{ readonly mode: Mode; readonly versionPageSha256: Sha256 | "erased" }> {
		const block = this.#flash.slice(PROTOCOL_BASE, PROTOCOL_BASE + VERSION_BLOCK_BYTES);
		return { mode: this.#bootMode(), versionPageSha256: block.every((b) => b === 0xff) ? "erased" : await sha256Of(block) };
	}

	plug(socket: Socket): Plug {
		this.#sockets.add(socket);
		return {
			send: (bytes) => this.#receive(socket, Uint8Array.from(bytes)),
			unplug: () => this.#sockets.delete(socket),
		};
	}

	onEnumerate(listener: (mode: Mode) => void): () => void {
		this.#enumerationListeners.add(listener);
		return () => this.#enumerationListeners.delete(listener);
	}

	whenIn(modes: readonly Mode[], signal: AbortSignal): Promise<void> {
		if (this.#present && modes.includes(this.#mode)) return Promise.resolve();
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const arrival = { modes, resolve };
			signal.addEventListener("abort", () => {
				const at = this.#arrivals.indexOf(arrival);
				if (at !== -1) this.#arrivals.splice(at, 1);
				reject(signal.reason);
			});
			this.#arrivals.push(arrival);
		});
	}

	/**
	 * A shell that watches enumeration, as a Node shell would. An open for a mode the board is not in waits for the next
	 * enumeration, and rejects LinkLost when the board comes back in a mode the caller did not ask for (a RESET that
	 * the board never received, so it re-enumerated where it was). The job counts a loss and observes again.
	 */
	port(): DevicePort {
		return {
			open: async (want, signal) => {
				if (!this.#present || !want.modes.includes(this.#mode)) {
					const arrived = await this.#nextEnumeration(signal);
					if (!want.modes.includes(arrived)) throw new LinkLost(`the board came back in ${arrived === "app" ? "normal" : "update"} mode`);
				}
				return new FakeLink(this, this.#mode);
			},
			exclusive: (job) => job(),
			clock: this.clock,
		};
	}

	#nextEnumeration(signal: AbortSignal): Promise<Mode> {
		return new Promise<Mode>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const onAbort = () => {
				stop();
				reject(signal.reason);
			};
			const stop = this.onEnumerate((mode) => {
				stop();
				signal.removeEventListener("abort", onAbort);
				resolve(mode);
			});
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	#receive(socket: Socket, bytes: Uint8Array): void {
		const index = this.#packets++;
		if (this.options.loseLinkAtPacket === index) {
			if (this.options.resetOnLoss) this.#reset(this.#bootMode());
			else this.#reenumerate(this.#mode);
			return;
		}
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#received.push({ t: this.clock.now(), cmd: bytes[0] ?? 0, sub: bytes[1] ?? 0, mode: this.#mode, words: [view.getUint32(4, true), view.getUint32(8, true)] });
		if (this.clock instanceof VirtualClock) this.clock.advance(COMMAND_MS);
		if (this.options.loseLinkAfterPacket === index) {
			const generation = this.#generation;
			this.#handle(socket, bytes, true);
			// A RESET the board took has already scheduled its own re-enumeration; the lost ack adds nothing.
			if (generation !== this.#generation) return;
			if (this.options.resetOnLoss) this.#reset(this.#bootMode());
			else this.#reenumerate(this.#mode);
			return;
		}
		queueMicrotask(() => this.#handle(socket, bytes));
	}

	/** `mute` executes the command and sends nothing back, on time or late. */
	#handle(socket: Socket, bytes: Uint8Array, mute = false): void {
		if (mute) socket = { report: () => undefined, detached: () => undefined, late: () => undefined };
		else if (!this.#sockets.has(socket)) return;
		const cmd = bytes[0] ?? 0;
		const sub = bytes[1] ?? 0;
		const slow = this.#slowOnce;
		if (!mute && slow !== null && slow.cmd === cmd && slow.sub === sub && slow.mode === this.#mode) {
			if (this.#slowSkip > 0) this.#slowSkip--;
			else {
				this.#slowOnce = null;
				this.#late(socket, slow.ms, () => this.#handle(socket, bytes));
				return;
			}
		}
		const echo = bytes.subarray(2, 4);
		const reply = (payload: Uint8Array) => {
			const out = new Uint8Array(REPORT_BYTES);
			out[0] = cmd;
			out[1] = sub;
			out.set(echo, 2);
			out.set(payload.subarray(0, PAYLOAD_BYTES), PAYLOAD_OFFSET);
			socket.report(out);
		};
		// The app's error marker (docs/app-firmware.md, 0x7684..0x76A8): FF AA 00 00, then the request's bytes 0..3.
		const refuse = () => {
			const out = new Uint8Array(REPORT_BYTES);
			out[0] = 0xff;
			out[1] = 0xaa;
			out.set(bytes.subarray(0, 4), 4);
			socket.report(out);
		};
		const always = this.options.refuseAlways;
		if (always !== undefined && always.cmd === cmd && always.sub === sub) return refuse();
		if (this.#refuseOnce !== null && this.#refuseOnce.cmd === cmd && this.#refuseOnce.sub === sub) {
			this.#refuseOnce = null;
			refuse();
			return;
		}
		if (this.#mode === "iap" && this.ignoreInIap) return this.#late(socket, Number.POSITIVE_INFINITY, () => undefined);
		const mode = this.#mode;
		const versionPagePart = (part: number) => reply(this.#flash.subarray(PROTOCOL_BASE + part * PAYLOAD_BYTES, PROTOCOL_BASE + (part + 1) * PAYLOAD_BYTES));
		if (cmd === 0x12 && sub === 0x00) return reply((mode === "iap" ? this.options.blInfoInIap : undefined) ?? this.#flash.subarray(BL_INFO_ADDR, BL_INFO_ADDR + BL_INFO_BYTES));
		if (cmd === 0x12 && sub === 0x02) return reply(Uint8Array.of(mode === "app" ? 1 : 0));
		if (cmd === 0x12 && sub >= 0x20 && sub < 0x20 + (mode === "app" ? VERSION_PAGE_PARTS_APP : VERSION_PAGE_PARTS_IAP)) return versionPagePart(sub - 0x20);
		if (mode === "app" && cmd === 0x11 && sub === 0x00) return this.#reset("iap");
		if (mode === "app" && cmd === 0x41) {
			const timer = (bytes[2] ?? 0) | ((bytes[3] ?? 0) << 8);
			if (sub === GATE_QUERY) {
				const out = new Uint8Array(REPORT_BYTES);
				out[0] = cmd;
				out[1] = this.#gate;
				new DataView(out.buffer).setUint16(2, this.#gateTimer, true);
				socket.report(out);
				return;
			}
			if (!SAFE_GATES.includes(sub)) this.#violations.push({ kind: "unsafe-config", cmd, sub, value: sub });
			if ((this.#gate & GATE_CONFIG_MODE) !== 0 && (sub & GATE_CONFIG_MODE) === 0) this.#loadSavedStore();
			this.#gate = sub;
			this.#gateTimer = timer;
			if ((this.#gate & GATE_SILENT) !== 0) return;
			return reply(new Uint8Array(0));
		}
		if (mode === "app" && cmd === 0x51 && (this.#gate & GATE_OPEN_MASK) === 0) return refuse();
		if (mode === "app" && cmd === 0x51 && sub === 0x20) {
			const index = (bytes[2] ?? 0) | ((bytes[3] ?? 0) << 8);
			const value = (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8);
			if (value >>> 8 !== 0) this.#violations.push({ kind: "unsafe-config", cmd, sub, value });
			if (index > MAX_KEY_INDEX || value > MAX_KEY_VALUE || value === ABSENT) return refuse();
			const cell = this.#reverse[index & 0xff]!;
			if (cell === 0xff) return refuse();
			const at = (index >> 8) * KEY_CELLS + cell;
			this.#overrides[at] = value & 0xff;
			if ((value & 0xff) !== NO_OVERRIDE) this.#overrideFlags[at] = value >>> 8;
			if ((this.#gate & GATE_SILENT) !== 0) return;
			const payload = new Uint8Array(2);
			new DataView(payload.buffer).setUint16(0, this.#overrideEntry(index), true);
			return reply(payload);
		}
		if (mode === "app" && cmd === 0x52 && (sub === 0x20 || sub === 0x21)) {
			const arg = (bytes[2] ?? 0) | ((bytes[3] ?? 0) << 8);
			const words = sub === 0x20 ? (arg <= 0x2ff ? [arg] : null) : arg <= 0x3f ? Array.from({ length: 16 }, (_, i) => (arg & 0xf) * 16 + i) : null;
			if (words === null) return refuse();
			const payload = new Uint8Array(2 * words.length);
			const view = new DataView(payload.buffer);
			words.forEach((index, i) => {
				const word = this.#overrideEntry(index);
				view.setUint16(2 * i, word === NO_SUCH_KEY ? ABSENT : word, true);
			});
			return reply(payload);
		}
		if (mode === "iap") {
			if (cmd === 0x12 && sub === 0x01) return reply(FW_INFO);
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			if (cmd === 0x1d && (sub === 0x00 || sub === 0x01)) {
				const offset = view.getUint32(4, true);
				const length = view.getUint32(8, true);
				if (offset + length > WINDOW_BYTES || length === 0) {
					this.#violations.push({ kind: "outside-window", cmd, offset, length });
					return refuse();
				}
				if (sub === 0x00 && offset !== 0 && this.options.offsetErase !== undefined) {
					return this.options.offsetErase === "error-marker" ? refuse() : this.#late(socket, Number.POSITIVE_INFINITY, () => undefined);
				}
				if (sub === 0x00) {
					if (offset % PAGE_SIZE !== 0 || length % PAGE_SIZE !== 0) return refuse();
					this.#erase(offset / PAGE_SIZE, length / PAGE_SIZE);
					return reply(new Uint8Array(0));
				}
				const payload = new Uint8Array(4);
				new DataView(payload.buffer).setUint32(0, this.#sum(PROTOCOL_BASE + offset, length), true);
				return reply(payload);
			}
			if (cmd === 0x1e && sub === 0x01) {
				const offset = view.getUint32(4, true);
				if (offset >= WINDOW_BYTES) {
					this.#violations.push({ kind: "outside-window", cmd, offset, length: 1 });
					this.#cursor = null;
					return refuse();
				}
				this.#cursor = offset;
				return reply(new Uint8Array(0));
			}
			// The vendor sends 0xFFFFFFFF and reads the cursor from bytes 4..7 (U2, 0x4089B0). A board with no cursor set
			// answering all ones is a GUESS.
			if (cmd === 0x1e && sub === 0x00) {
				const n = this.#cursorReads++;
				const fault = this.options.cursorFault;
				const misreport = fault !== undefined && n >= fault.at && n < fault.at + fault.times;
				const payload = new Uint8Array(4);
				new DataView(payload.buffer).setUint32(0, this.#cursor === null ? 0xffffffff : this.#cursor + (misreport ? 4 : 0), true);
				return reply(payload);
			}
			if (cmd === 0x1f && sub >= 1 && sub <= WRITE_CHUNK_BYTES) {
				const n = this.#writes++;
				const fault = this.options.writeFault;
				const faulty = fault !== undefined && n >= fault.at && n < fault.at + fault.times ? fault.kind : null;
				if (faulty === "no-reply") return this.#late(socket, Number.POSITIVE_INFINITY, () => undefined);
				const at = this.#cursor;
				if (at === null) return refuse();
				if (at + sub > WINDOW_BYTES) {
					this.#violations.push({ kind: "outside-window", cmd, offset: at, length: sub });
					this.#cursor = null;
					return refuse();
				}
				this.#write(at, bytes.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + sub));
				this.#cursor = at + sub;
				if (faulty === "mute") return this.#late(socket, Number.POSITIVE_INFINITY, () => undefined);
				// The write ack (docs/protocol.md "Packet framing"): 1E 02, then the next write address, which the host compares with its own cursor.
				const out = new Uint8Array(REPORT_BYTES);
				out[0] = 0x1e;
				out[1] = 0x02;
				out.set(echo, 2);
				new DataView(out.buffer).setUint32(PAYLOAD_OFFSET, this.#cursor + (faulty === "wrong-next" ? 4 : 0), true);
				socket.report(out);
				return;
			}
			if (cmd === 0x11 && sub === 0x01) return this.#reset(this.#bootMode());
			if (cmd === 0x1d && sub === 0x02) {
				this.#violations.push({ kind: "not-modeled", cmd, sub });
				return refuse();
			}
		}
		this.#violations.push({ kind: "wrong-mode", cmd, sub, mode });
		refuse();
	}

	/** sub_5E98(index, 3): index is layer << 8 | active usage. */
	#overrideEntry(index: number): number {
		const cell = this.#reverse[index & 0xff]!;
		if (cell === 0xff) return NO_SUCH_KEY;
		const at = (index >> 8) * KEY_CELLS + cell;
		const byte = this.#overrides[at]!;
		return byte === NO_OVERRIDE ? NO_OVERRIDE : (this.#overrideFlags[at]! << 8) | byte;
	}

	#late(socket: Socket, ms: number, deliver: () => void): void {
		if (socket.late !== undefined) socket.late(ms, deliver);
		else if (Number.isFinite(ms)) setTimeout(deliver, ms);
	}

	#pageValid(): boolean {
		return this.#bootMode() === "app";
	}

	#erase(firstPage: number, pages: number): void {
		const order = Array.from({ length: pages }, (_, i) => firstPage + i);
		if ((this.options.eraseOrder ?? "descending") === "descending") order.reverse();
		if (this.clock instanceof VirtualClock) this.clock.advance(pages * ERASE_PAGE_MS);
		for (const page of order) {
			if (page * PAGE_SIZE >= FW_OFFSET && this.#pageValid()) this.#violations.push({ kind: "app-changed-under-valid-page", page });
			this.#flash.fill(0xff, PROTOCOL_BASE + page * PAGE_SIZE, PROTOCOL_BASE + (page + 1) * PAGE_SIZE);
		}
	}

	/** NOR flash: a write clears bits and never sets them, so writing over unerased bytes leaves their AND. */
	#write(at: number, data: Uint8Array): void {
		const wasValid = this.#pageValid();
		if (at + data.length > FW_OFFSET && wasValid) {
			this.#violations.push({ kind: "app-changed-under-valid-page", page: Math.floor(Math.max(at, FW_OFFSET) / PAGE_SIZE) });
		}
		const target = this.#flash.subarray(PROTOCOL_BASE + at, PROTOCOL_BASE + at + data.length);
		target.set(target.map((old, i) => old & (data[i] ?? 0xff)));
		if (!wasValid && this.#pageValid() && this.#sum(PROTOCOL_BASE + FW_OFFSET, this.options.target.imageBytes) !== this.options.target.wireSum32 >>> 0) {
			this.#violations.push({ kind: "version-block-before-verified-image" });
		}
	}

	#sum(from: number, length: number): number {
		const view = new DataView(this.#flash.buffer, from, length);
		let sum = 0;
		for (let at = 0; at + 4 <= length; at += 4) sum = (sum + view.getUint32(at, true)) >>> 0;
		return sum;
	}

	/** The IAP boots the app only over a version page with its magic and a non-0xFF word at 0x78 (docs/protocol.md, INFERRED). */
	#bootMode(): Mode {
		const view = new DataView(this.#flash.buffer, PROTOCOL_BASE, PAGE_SIZE);
		const magic = view.getUint16(MAGIC_OFFSET, true) === MAGIC;
		const fixed = view.getUint32(FIXED_WORDS_OFFSET, true) !== 0xffffffff;
		return magic && fixed ? "app" : "iap";
	}

	/** sub_4470: the profile block back from flash over the RAM store, dropping every unsaved write. */
	#loadSavedStore(): void {
		this.#overrides.set(this.#savedOverrides);
		this.#overrideFlags.set(this.#savedFlags);
	}

	/** An MCU reset: SRAM, and with it the write address, the gate, and every unsaved store write, is gone. */
	#reset(into: Mode): void {
		this.#cursor = null;
		this.#gate = 0;
		this.#gateTimer = 0;
		this.#loadSavedStore();
		this.#reenumerate(into);
	}

	/** A USB glitch: the host sees the device leave and come back; the MCU keeps running. */
	#reenumerate(into: Mode): void {
		this.#detachAll();
		this.#present = false;
		const generation = ++this.#generation;
		setTimeout(() => generation === this.#generation && this.#enumerate(into), this.options.reenumerateAfterMs ?? 2);
	}

	#detachAll(): void {
		for (const socket of [...this.#sockets]) {
			this.#sockets.delete(socket);
			socket.detached();
		}
	}

	#enumerate(mode: Mode): void {
		this.#mode = mode;
		this.#present = true;
		for (const arrival of this.#arrivals.splice(0)) {
			if (arrival.modes.includes(mode)) arrival.resolve();
			else this.#arrivals.push(arrival);
		}
		for (const listener of this.#enumerationListeners) listener(mode);
	}
}

interface Waiter {
	readonly timeoutMs: number;
	readonly resolve: (report: InReport) => void;
	readonly reject: (error: Error) => void;
}

/**
 * On the real clock, input goes through the core's ReportQueue and its timers. On the virtual clock, the link keeps
 * its own inbox: a request's timeout fires only when the board reports an answer late or never, which advances the
 * clock to the reply or to the timeout, whichever comes first. An answer later than the timeout stays due at its own
 * time, and arrives at the first wait or discard that reaches that time, as a late report would on a real link.
 */
class FakeLink implements Link {
	readonly #queue = new ReportQueue();
	readonly #plug: Plug;
	readonly #virtual: VirtualClock | null;
	readonly #inbox: InReport[] = [];
	#waiter: Waiter | null = null;
	#late: { readonly ms: number; readonly deliver: () => void } | null = null;
	/** Answers that missed their request's timeout, by the virtual time they arrive. */
	readonly #due: { readonly at: number; readonly deliver: () => void }[] = [];
	#endedBy: LinkLost | null = null;
	#ended = false;
	readonly lost: Promise<void>;

	constructor(board: FakeTab60, readonly mode: Mode) {
		let settleLost = () => undefined as void;
		this.lost = new Promise<void>((resolve) => {
			settleLost = resolve;
		});
		this.#virtual = board.clock instanceof VirtualClock ? board.clock : null;
		this.#plug = board.plug({
			report: (bytes) => this.#push(asInReport(bytes)),
			detached: () => {
				this.#end(new LinkLost("the board re-enumerated"));
				settleLost();
			},
			...(this.#virtual === null ? {} : { late: (ms: number, deliver: () => void) => this.#onLate(ms, deliver) }),
		});
	}

	async send(frame: OutReport): Promise<void> {
		if (this.#ended) throw new LinkLost("the link is gone");
		this.#plug.send(frame);
	}

	next(timeoutMs: number): Promise<InReport> {
		if (this.#virtual === null) return this.#queue.next(timeoutMs);
		if (this.#endedBy !== null) return Promise.reject(this.#endedBy);
		this.#arrive(this.#virtual.now());
		const queued = this.#inbox.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise<InReport>((resolve, reject) => {
			const waiter = { timeoutMs, resolve, reject };
			const late = this.#late;
			this.#late = null;
			if (late !== null) return this.#settleLate(late, waiter);
			const due = this.#due[0];
			const clock = this.#virtual;
			if (due === undefined || clock === null || due.at > clock.now() + timeoutMs) {
				this.#waiter = waiter;
				return;
			}
			clock.advance(due.at - clock.now());
			this.#waiter = waiter;
			this.#arrive(clock.now());
		});
	}

	discardPending(): readonly InReport[] {
		if (this.#virtual === null) return this.#queue.discardPending();
		this.#arrive(this.#virtual.now());
		return this.#inbox.splice(0);
	}

	/** Delivers every late answer due by `now`, in order. */
	#arrive(now: number): void {
		while (this.#due.length > 0 && this.#due[0]!.at <= now) this.#due.shift()?.deliver();
	}

	async close(): Promise<void> {
		if (this.#ended) return;
		this.#plug.unplug();
		this.#end(new LinkLost("closed"));
	}

	#push(report: InReport): void {
		if (this.#virtual === null) return this.#queue.push(report);
		if (this.#endedBy !== null) return;
		const waiter = this.#waiter;
		this.#waiter = null;
		if (waiter === null) this.#inbox.push(report);
		else waiter.resolve(report);
	}

	#end(error: LinkLost): void {
		if (this.#ended) return;
		this.#ended = true;
		if (this.#virtual === null) return this.#queue.end(error);
		this.#endedBy = error;
		this.#inbox.length = 0;
		this.#due.length = 0;
		this.#late = null;
		this.#waiter?.reject(error);
		this.#waiter = null;
	}

	#onLate(ms: number, deliver: () => void): void {
		const waiter = this.#waiter;
		this.#waiter = null;
		if (waiter === null) this.#late = { ms, deliver };
		else this.#settleLate({ ms, deliver }, waiter);
	}

	#settleLate(late: { readonly ms: number; readonly deliver: () => void }, waiter: Waiter): void {
		const clock = this.#virtual;
		if (clock === null) return;
		if (late.ms <= waiter.timeoutMs) {
			clock.advance(late.ms);
			this.#waiter = waiter;
			late.deliver();
			return;
		}
		clock.advance(waiter.timeoutMs);
		waiter.reject(new LinkTimeout(`no input report within ${waiter.timeoutMs} ms`));
		if (Number.isFinite(late.ms)) {
			this.#due.push({ at: clock.now() + late.ms - waiter.timeoutMs, deliver: late.deliver });
			this.#due.sort((a, b) => a.at - b.at);
		}
	}
}
