/**
 * A behavioral model of the TAB 60 on the vendor interface, for tests. It is R1's protocol spec and R4's app
 * command map in executable form. Every behavior it models is INFERRED until a hardware transcript (U1, U7)
 * confirms it; when the two disagree, the transcript wins and this file changes.
 *
 * It must not import the host codec (candidate B). It implements R1's and R4's tables from the documents with its
 * own byte handling, so a codec bug in the core and the same bug in the fake cannot cancel out. probes/boundaries.ts
 * fails the build when this file's imports reach core/ anywhere but port.ts, the seam it implements, and units.ts.
 * The facts it checks against (the target image's length and wire sum) come in through FakeOptions from the test.
 *
 * It also records violations: anything a real board might accept that this tool must never send.
 *
 * This is the read-only subset plan unit U1 needs: both modes' reads, SUM over stored bytes, and the two resets.
 * Erase, write, the drop points, and the virtual clock come with U5.
 */
import type { Clock, DevicePort, InReport, Link, Mode, OutReport } from "../core/port";
import { LinkLost, ReportQueue, asInReport } from "../core/port";
import { type Sha256, notImplemented } from "../core/units";

export interface FakeOptions {
	/** What the board holds at the start of the test. */
	readonly starting: "official-image" | "untrusted-image" | "update-mode-erased" | "update-mode-partial-version-block";
	/** The image a correct run ends with, from the catalog entry the test flashes. */
	readonly target: { readonly imageBytes: number; readonly wireSum32: number };
	/** Lose the link right before the board would receive this output report (counted from 0 across the run). */
	readonly loseLinkAtPacket?: number;
	/** On that loss, also reset the MCU: SRAM is cleared and the IAP decides from the version page. */
	readonly resetOnLoss?: boolean;
	/**
	 * The order one ERASE command clears its pages in. Nothing documents the IAP's order, so tests default to
	 * "descending", the order in which an erase that covers the version page clears it last. Unused until U5 adds ERASE.
	 */
	readonly eraseOrder?: "ascending" | "descending";
	/** The board answers this command with the FF AA error marker once. */
	readonly refuseOnce?: { readonly cmd: number; readonly sub: number };
	/** The 52 bytes at absolute 0x400. Default: `blInfoBlock()`, the layout docs/units.md U1 expects. */
	readonly blInfo?: Uint8Array;
	/** What READ FW INFO answers in update mode. Default 0x200, BL info's fw_offset. */
	readonly fwInfo?: number;
	/** The 180-byte version block a starting state with a page holds. Default: `versionBlock()`. */
	readonly versionBlock?: Uint8Array;
	/**
	 * How long after a reset the board enumerates again. A real board takes about a second, long after a chooser
	 * opened by the same click is on screen; a few milliseconds keep that order without slowing tests.
	 */
	readonly reenumerateAfterMs?: number;
}

export type Violation =
	/** ERASE, SUM, CRC, set-address, or WRITE that touches [0x0, 0x3000) or [0x1FE00, ...), or wraps 32 bits. */
	| { readonly kind: "outside-window"; readonly cmd: number; readonly offset: number; readonly length: number }
	/** The version block's magic written while the image range did not sum to the target's wire sum. */
	| { readonly kind: "version-block-before-verified-image" }
	/** An app page changed while the version page still held its magic: a reset right then would boot a damaged image. */
	| { readonly kind: "app-changed-under-valid-page"; readonly page: number }
	/** A config command (0x40 and up) sent during a flash job, or any command in a mode that lacks it. */
	| { readonly kind: "wrong-mode"; readonly cmd: number; readonly sub: number; readonly mode: Mode };

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
export const VERSION_BLOCK_BYTES = 180;
const VERSION_PAGE_PARTS_APP = 8;
const VERSION_PAGE_PARTS_IAP = 3;
const MAGIC_OFFSET = 0xb0;
const MAGIC = 0x5aa5;
const FIXED_WORDS_OFFSET = 0x78;

/** R1 "BL info block" (struct <IIHHHHIIIIHHH10sI) with the TAB 60 values docs/units.md U1 expects, field by field. */
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

/**
 * R1 "Version page": the string's byte length, the version as UTF-16LE in a 26-byte field, 0xFF up to 0x78, the
 * fixed words, the app VID:PID, and the magic at 0xB0. The vendor's own block is not public, so this one hashes
 * to no catalog entry; it is a V1.01.13-shaped page, not V1.01.13's page.
 */
export function versionBlock(version = "V1.01.13"): Uint8Array {
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

/** `length` bytes whose little-endian u32 words sum to `sum`: a stand-in for an image this tool never ships. */
export function bytesSummingTo(length: number, sum: number): Uint8Array {
	if (length % 4 !== 0 || length < 4) throw new RangeError(`image length ${length} is not whole words`);
	const bytes = new Uint8Array(length);
	new DataView(bytes.buffer).setUint32(0, sum >>> 0, true);
	return bytes;
}

/** What a shell adapter gets when it plugs into the board: a way to send, and a way to unplug. */
export interface Plug {
	send(bytes: Uint8Array): void;
	unplug(): void;
}

/** What the board calls back on the adapter: a report arrived, or the board re-enumerated and this plug is dead. */
export interface Socket {
	readonly report: (bytes: Uint8Array) => void;
	readonly detached: () => void;
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

export class FakeTab60 {
	#mode: Mode;
	readonly #flash = new Uint8Array(FLASH_BYTES).fill(0xff);
	readonly #fwInfo: number;
	readonly #sockets = new Set<Socket>();
	readonly #arrivals: { readonly modes: readonly Mode[]; readonly resolve: () => void }[] = [];
	readonly #enumerationListeners = new Set<(mode: Mode) => void>();
	#refuseOnce: { readonly cmd: number; readonly sub: number } | null;
	#packets = 0;
	readonly #violations: Violation[] = [];
	/** A bootloader that ignores our frames (the "no answer in update mode" case): update mode replies to nothing. */
	ignoreInIap = false;

	constructor(readonly options: FakeOptions) {
		const { starting, target } = options;
		this.#fwInfo = options.fwInfo ?? FW_OFFSET;
		this.#refuseOnce = options.refuseOnce ?? null;
		this.#flash.set(options.blInfo ?? blInfoBlock(), BL_INFO_ADDR);
		const page = options.versionBlock ?? versionBlock();
		const official = bytesSummingTo(target.imageBytes, target.wireSum32);
		const untrusted = bytesSummingTo(target.imageBytes, target.wireSum32 + 1);
		this.#mode = starting === "official-image" || starting === "untrusted-image" ? "app" : "iap";
		switch (starting) {
			case "official-image":
				this.#flash.set(page, PROTOCOL_BASE);
				this.#flash.set(official, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "untrusted-image":
				this.#flash.set(versionBlock("V0.00.00"), PROTOCOL_BASE);
				this.#flash.set(untrusted, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "update-mode-erased":
				this.#flash.set(official, PROTOCOL_BASE + FW_OFFSET);
				break;
			case "update-mode-partial-version-block":
				this.#flash.set(page.subarray(0, 52), PROTOCOL_BASE);
				this.#flash.set(official, PROTOCOL_BASE + FW_OFFSET);
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

	/** Where the board would go on its next reset, and what its version page holds. U5. */
	bootTarget(): { readonly mode: Mode; readonly versionPageSha256: Sha256 | "erased" } {
		return notImplemented("bootTarget");
	}

	/** The USB cable: an adapter plugs into the device the board currently enumerates, sends frames, and gets reports until a reset. */
	plug(socket: Socket): Plug {
		this.#sockets.add(socket);
		return {
			send: (bytes) => this.#receive(socket, Uint8Array.from(bytes)),
			unplug: () => this.#sockets.delete(socket),
		};
	}

	/** Called with the new mode each time the board re-enumerates. Returns the unsubscribe function. */
	onEnumerate(listener: (mode: Mode) => void): () => void {
		this.#enumerationListeners.add(listener);
		return () => this.#enumerationListeners.delete(listener);
	}

	/** Resolves when the board is enumerated in one of `modes`, at once if it already is. */
	whenIn(modes: readonly Mode[], signal: AbortSignal): Promise<void> {
		if (modes.includes(this.#mode)) return Promise.resolve();
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

	/** A port that reconnects at once, like a polling Node shell. */
	port(): DevicePort {
		return {
			open: async (want, signal) => {
				await this.whenIn(want.modes, signal);
				return new FakeLink(this, this.#mode);
			},
			exclusive: (job) => job(),
			clock: realClock,
		};
	}

	#receive(socket: Socket, bytes: Uint8Array): void {
		const index = this.#packets++;
		if (this.options.loseLinkAtPacket === index) {
			this.#detachAll();
			if (this.options.resetOnLoss) this.#reset(this.#bootMode());
			return;
		}
		queueMicrotask(() => this.#handle(socket, bytes));
	}

	#handle(socket: Socket, bytes: Uint8Array): void {
		if (!this.#sockets.has(socket)) return;
		const cmd = bytes[0] ?? 0;
		const sub = bytes[1] ?? 0;
		const echo = bytes.subarray(2, 4);
		const reply = (payload: Uint8Array) => {
			const out = new Uint8Array(REPORT_BYTES);
			out[0] = cmd;
			out[1] = sub;
			out.set(echo, 2);
			out.set(payload.subarray(0, PAYLOAD_BYTES), PAYLOAD_OFFSET);
			socket.report(out);
		};
		const refuse = () => {
			const out = new Uint8Array(REPORT_BYTES);
			out[0] = 0xff;
			out[1] = 0xaa;
			out.set(echo, 2);
			out[4] = cmd;
			out[5] = sub;
			socket.report(out);
		};
		if (this.#refuseOnce !== null && this.#refuseOnce.cmd === cmd && this.#refuseOnce.sub === sub) {
			this.#refuseOnce = null;
			refuse();
			return;
		}
		if (this.#mode === "iap" && this.ignoreInIap) return;
		const mode = this.#mode;
		const versionPagePart = (part: number) => reply(this.#flash.subarray(PROTOCOL_BASE + part * PAYLOAD_BYTES, PROTOCOL_BASE + (part + 1) * PAYLOAD_BYTES));
		if (cmd === 0x12 && sub === 0x00) return reply(this.#flash.subarray(BL_INFO_ADDR, BL_INFO_ADDR + BL_INFO_BYTES));
		if (cmd === 0x12 && sub === 0x02) return reply(Uint8Array.of(mode === "app" ? 1 : 0));
		if (cmd === 0x12 && sub >= 0x20 && sub < 0x20 + (mode === "app" ? VERSION_PAGE_PARTS_APP : VERSION_PAGE_PARTS_IAP)) return versionPagePart(sub - 0x20);
		if (mode === "app" && cmd === 0x11 && sub === 0x00) return this.#reset("iap");
		if (mode === "iap") {
			if (cmd === 0x12 && sub === 0x01) {
				const payload = new Uint8Array(4);
				new DataView(payload.buffer).setUint32(0, this.#fwInfo, true);
				return reply(payload);
			}
			if (cmd === 0x1d && sub === 0x01) {
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				const offset = view.getUint32(4, true);
				const length = view.getUint32(8, true);
				if (offset + length > WINDOW_BYTES || length === 0) {
					this.#violations.push({ kind: "outside-window", cmd, offset, length });
					return refuse();
				}
				const payload = new Uint8Array(4);
				new DataView(payload.buffer).setUint32(0, this.#sum(PROTOCOL_BASE + offset, length), true);
				return reply(payload);
			}
			if (cmd === 0x11 && sub === 0x01) return this.#reset(this.#bootMode());
		}
		this.#violations.push({ kind: "wrong-mode", cmd, sub, mode });
		refuse();
	}

	/** The wrapping sum of little-endian words over stored bytes: what the IAP answers for SUM (R1, candidate B). */
	#sum(from: number, length: number): number {
		const view = new DataView(this.#flash.buffer, from, length);
		let sum = 0;
		for (let at = 0; at + 4 <= length; at += 4) sum = (sum + view.getUint32(at, true)) >>> 0;
		return sum;
	}

	/** The IAP boots the app only when the version page carries its magic and the words from 0x78 are not 0xFF (R1, INFERRED). */
	#bootMode(): Mode {
		const view = new DataView(this.#flash.buffer, PROTOCOL_BASE, PAGE_SIZE);
		const magic = view.getUint16(MAGIC_OFFSET, true) === MAGIC;
		const fixed = view.getUint32(FIXED_WORDS_OFFSET, true) !== 0xffffffff;
		return magic && fixed ? "app" : "iap";
	}

	#reset(into: Mode): void {
		this.#detachAll();
		setTimeout(() => this.#enumerate(into), this.options.reenumerateAfterMs ?? 2);
	}

	#detachAll(): void {
		for (const socket of [...this.#sockets]) {
			this.#sockets.delete(socket);
			socket.detached();
		}
	}

	#enumerate(mode: Mode): void {
		this.#mode = mode;
		for (const arrival of this.#arrivals.splice(0)) {
			if (arrival.modes.includes(mode)) arrival.resolve();
			else this.#arrivals.push(arrival);
		}
		for (const listener of this.#enumerationListeners) listener(mode);
	}
}

class FakeLink implements Link {
	readonly #queue = new ReportQueue();
	readonly #plug: Plug;
	#ended = false;
	readonly lost: Promise<void>;

	constructor(board: FakeTab60, readonly mode: Mode) {
		let settleLost = () => undefined as void;
		this.lost = new Promise<void>((resolve) => {
			settleLost = resolve;
		});
		this.#plug = board.plug({
			report: (bytes) => this.#queue.push(asInReport(bytes)),
			detached: () => {
				this.#ended = true;
				this.#queue.end(new LinkLost("the board re-enumerated"));
				settleLost();
			},
		});
	}

	async send(frame: OutReport): Promise<void> {
		if (this.#ended) throw new LinkLost("the link is gone");
		this.#plug.send(frame);
	}

	next(timeoutMs: number): Promise<InReport> {
		return this.#queue.next(timeoutMs);
	}

	discardPending(): void {
		this.#queue.discardPending();
	}

	async close(): Promise<void> {
		if (this.#ended) return;
		this.#ended = true;
		this.#plug.unplug();
		this.#queue.end(new LinkLost("closed"));
	}
}
