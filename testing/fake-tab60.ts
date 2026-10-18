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
	/** The order the IAP erases the pages of one ERASE, which R1 does not document. Default "descending", the order that punishes one ERASE over the whole window. */
	readonly eraseOrder?: "descending" | "ascending";
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
	| { readonly kind: "not-modeled"; readonly cmd: number; readonly sub: number };

/** One output report the board received, stamped with the fake's clock. */
export interface Received {
	readonly t: number;
	readonly cmd: number;
	readonly sub: number;
	readonly mode: Mode;
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
/** Virtual time each command costs, and each erased page on top: rough, so gaps and waits are not all zero. */
const COMMAND_MS = 1;
const ERASE_PAGE_MS = 10;

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
	/** The IAP's write address, a window offset, held in SRAM until the next MCU reset. */
	#cursor: number | null = null;
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
		this.#received.push({ t: this.clock.now(), cmd: bytes[0] ?? 0, sub: bytes[1] ?? 0, mode: this.#mode });
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
		const refuse = () => {
			const out = new Uint8Array(REPORT_BYTES);
			out[0] = 0xff;
			out[1] = 0xaa;
			out.set(echo, 2);
			out[4] = cmd;
			out[5] = sub;
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
			if (cmd === 0x1f && sub >= 1 && sub <= WRITE_CHUNK_BYTES) {
				const at = this.#cursor;
				if (at === null) return refuse();
				if (at + sub > WINDOW_BYTES) {
					this.#violations.push({ kind: "outside-window", cmd, offset: at, length: sub });
					this.#cursor = null;
					return refuse();
				}
				this.#write(at, bytes.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + sub));
				this.#cursor = at + sub;
				// R1's write ack: 1E 02, then the next write address, which the host compares with its own cursor.
				const out = new Uint8Array(REPORT_BYTES);
				out[0] = 0x1e;
				out[1] = 0x02;
				out.set(echo, 2);
				new DataView(out.buffer).setUint32(PAYLOAD_OFFSET, this.#cursor, true);
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

	/** The IAP boots the app only over a version page with its magic and a non-0xFF word at 0x78 (R1, INFERRED). */
	#bootMode(): Mode {
		const view = new DataView(this.#flash.buffer, PROTOCOL_BASE, PAGE_SIZE);
		const magic = view.getUint16(MAGIC_OFFSET, true) === MAGIC;
		const fixed = view.getUint32(FIXED_WORDS_OFFSET, true) !== 0xffffffff;
		return magic && fixed ? "app" : "iap";
	}

	/** An MCU reset: SRAM, and with it the write address, is gone. */
	#reset(into: Mode): void {
		this.#cursor = null;
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
 * clock to the reply or to the timeout, whichever comes first.
 */
class FakeLink implements Link {
	readonly #queue = new ReportQueue();
	readonly #plug: Plug;
	readonly #virtual: VirtualClock | null;
	readonly #inbox: InReport[] = [];
	#waiter: Waiter | null = null;
	#late: { readonly ms: number; readonly deliver: () => void } | null = null;
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
		const queued = this.#inbox.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise<InReport>((resolve, reject) => {
			const waiter = { timeoutMs, resolve, reject };
			const late = this.#late;
			this.#late = null;
			if (late === null) this.#waiter = waiter;
			else this.#settleLate(late, waiter);
		});
	}

	discardPending(): readonly InReport[] {
		return this.#virtual === null ? this.#queue.discardPending() : this.#inbox.splice(0);
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
		if (Number.isFinite(late.ms)) late.deliver();
	}
}
