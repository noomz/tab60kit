/**
 * The seam between the core and a shell (the WebHID page, a later node-hid shell, the test fake).
 * A shell answers three questions: how to get a link to the board in a given mode, how to keep one job at a time
 * on this machine, and what time it is. Everything about commands, addresses, and policy stays in the core.
 *
 * Shells import this file. UI code imports index.ts. package.json "exports" exposes only those two entry points,
 * so protocol.ts and its sessions cannot be imported from outside the package.
 *
 * Raw bytes and the seam. `Link.send` takes an `OutReport`, and the core's egress audit (protocol.ts `auditEgress`)
 * is the only code that makes one, after it has decoded the frame and checked it. So code that holds a Link cannot
 * put bytes of its own on the wire without a cast, and probes/boundaries.ts fails the build on any cast to
 * OutReport outside protocol.ts and on any `sendReport` call outside web/webhid-port.ts. What TypeScript cannot
 * close: a shell's own `send` body is the byte path by necessity, so each shell is reviewed code; types are erased
 * at run time, so a value typed `any` passes; and any script running in the page's origin can call WebHID itself,
 * which the page's CSP (`script-src 'self'`) limits to the reviewed bundle.
 */
import type { Brand, Mode } from "./units";

/** What a shell needs to find the board: the identity table, the chooser filters, and the PID-to-mode mapping. */
export { TAB60, hidFilters, modeOf } from "./device";
export type { Mode } from "./units";
/** What G1 lets a kit send. Shells pass one through from a lab page; no shell can build one (protocol.ts). */
export type { Clearance } from "./protocol";

/** Exactly 64 bytes that the egress audit passed. Built only by protocol.ts `auditEgress`. */
export type OutReport = Brand<Uint8Array, "OutReport">;

/** Exactly 64 bytes the board sent. Built by a shell's `asInReport`. */
export type InReport = Brand<Uint8Array, "InReport">;

/** Validates an incoming report at the shell boundary. The one sanctioned cast for this brand. */
export function asInReport(bytes: Uint8Array): InReport {
	if (bytes.length !== 64) throw new Error(`HID report is ${bytes.length} bytes, expected 64`);
	return bytes as InReport;
}

/** Why the core needs a device now. The UI picks its copy from this; the shell may ignore it. */
export type WantReason = "connect" | "enter-update-mode" | "after-link-loss" | "confirm-normal-mode";

export interface DeviceWant {
	/** Accept a board in any of these modes. After a lost link the core accepts both, and the observed mode decides the next step. */
	readonly modes: readonly Mode[];
	readonly reason: WantReason;
}

/**
 * Time, from the shell. The page uses the real clock. The fake board runs a virtual one, so the 15 s link gate
 * (flash.ts) costs no wall time in the drop sweep.
 */
export interface Clock {
	now(): number;
	/** Resolves after `ms`, or rejects with the signal's reason. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface DevicePort {
	/**
	 * Resolves with a link to the TAB 60 vendor interface in one of `want.modes`. Never resolves a link for any other device.
	 * Web: may open a chooser at once (if the click's activation is still live) or wait for a pick from a click.
	 * Node: polls enumeration by VID, PID, and usage page. Fake: reconnects at once.
	 * Rejects with PickCancelled, OsPermissionDenied, or the signal's AbortError.
	 */
	open(want: DeviceWant, signal: AbortSignal): Promise<Link>;

	/**
	 * Runs `job` with exclusive use of the board across this machine's tabs or processes, or rejects with Busy.
	 * The board has one command buffer (R4), so two writers would interleave packets inside one request.
	 */
	exclusive<T>(job: () => Promise<T>): Promise<T>;

	readonly clock: Clock;
}

/** One USB connection to the vendor interface. Dies with the connection; a new connection needs a new link. */
export interface Link {
	/** From the product ID the shell opened (device.ts `modeOf`). */
	readonly mode: Mode;
	/** Sends one 64-byte output report with report ID 0. Only audited frames reach here. Rejects LinkLost or LinkTimeout. */
	send(report: OutReport): Promise<void>;
	/** The next input report, in arrival order. Rejects LinkLost or LinkTimeout. */
	next(timeoutMs: number): Promise<InReport>;
	/** Drops queued input reports, so a late reply to a timed-out request cannot pair with the next request. */
	discardPending(): void;
	/** Settles once, when the OS reports the device gone. Pending `send` and `next` calls reject LinkLost at the same moment. */
	readonly lost: Promise<void>;
	close(): Promise<void>;
}

/** The USB connection ended: unplug, re-enumeration, or a reset the core did not ask for. */
export class LinkLost extends Error {
	override readonly name = "LinkLost";
}

/** A call got no answer in time. Treated like a lost link: the handle may be stale (R3 C12). */
export class LinkTimeout extends Error {
	override readonly name = "LinkTimeout";
}

/** The user closed the chooser without picking. */
export class PickCancelled extends Error {
	override readonly name = "PickCancelled";
}

/** The OS refused to open the device. On Linux this means the udev rule is missing. */
export class OsPermissionDenied extends Error {
	override readonly name = "OsPermissionDenied";
	constructor(readonly os: "linux" | "other") {
		super(`the OS refused access to the vendor interface (${os})`);
	}
}

/** Another tab or process holds the board. */
export class Busy extends Error {
	override readonly name = "Busy";
}

interface Waiter {
	readonly resolve: (report: InReport) => void;
	readonly reject: (error: Error) => void;
}

/**
 * The input half of a Link, shared by every shell so they agree on what `next`, `discardPending`, and a lost link
 * mean: reports queue in arrival order, `next` hands out the oldest or waits up to its timeout, and `end` rejects
 * every waiter, now and later, with the link's LinkLost.
 */
export class ReportQueue {
	readonly #queue: InReport[] = [];
	readonly #waiters: Waiter[] = [];
	#ended: LinkLost | null = null;

	push(report: InReport): void {
		if (this.#ended !== null) return;
		const waiter = this.#waiters.shift();
		if (waiter === undefined) this.#queue.push(report);
		else waiter.resolve(report);
	}

	next(timeoutMs: number): Promise<InReport> {
		if (this.#ended !== null) return Promise.reject(this.#ended);
		const queued = this.#queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise<InReport>((resolve, reject) => {
			const waiter: Waiter = {
				resolve: (report) => {
					clearTimeout(timer);
					resolve(report);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			const timer = setTimeout(() => {
				this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
				reject(new LinkTimeout(`no input report within ${timeoutMs} ms`));
			}, timeoutMs);
			this.#waiters.push(waiter);
		});
	}

	discardPending(): void {
		this.#queue.length = 0;
	}

	end(error: LinkLost): void {
		if (this.#ended !== null) return;
		this.#ended = error;
		this.#queue.length = 0;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}
