/**
 * DevicePort over WebHID. Everything browser-specific lives here and nowhere else: chooser picks and user
 * activation, the input-report queue, disconnect detection, per-call timeouts (Chromium adds none, R3 C12),
 * stale handles, the Linux permission error, and the cross-tab lock.
 *
 * The port never leaves this module. `startWebHid` builds it, hands it to a kit, and returns the kit and a Chooser,
 * so UI code holds neither a DevicePort nor a Link. `WebHidLink.send` is the page's only `sendReport` call, and it
 * accepts only frames the core's egress audit passed (OutReport). probes/boundaries.ts holds both rules, and a
 * third: only lab pages may call `startWebHidLab`, which hands the port itself out.
 */
import { type Kit, createKit } from "@tab60kit/core";
import {
	Busy,
	type Clearance,
	type Clock,
	type DevicePort,
	type DeviceWant,
	type InReport,
	type Link,
	LinkLost,
	LinkTimeout,
	type Mode,
	OsPermissionDenied,
	type OutReport,
	PickCancelled,
	ReportQueue,
	TAB60,
	type WantReason,
	asInReport,
	hidFilters,
	modeOf,
} from "@tab60kit/core/port";

/** What the UI may do with the chooser: answer a parked pick from a click, and know whether one is parked. */
export interface Chooser {
	/** Call only from a click handler: the click is the user activation that `requestDevice` consumes (R3 C5). */
	pick(): void;
	/**
	 * A device request that needs a click to open the chooser, or null. JobState "awaiting-device" says the job is
	 * waiting; this says how: null means the chooser is already open, so the prompt only names the row to pick.
	 */
	readonly needsClick: DeviceWant | null;
}

/** One HID collection of an opened device, with its report sizes in bytes. */
export interface CollectionReport {
	readonly usagePage: number;
	readonly usage: number;
	readonly inputReportBytes: number;
	readonly outputReportBytes: number;
	readonly featureReportBytes: number;
}

/** What the shell saw, for a lab page's transcript (docs/units.md U1 checks 1 and 2). The shipped page gets none. */
export type PortEvent =
	/** One chooser: opened inside the click's activation, or from a parked pick's click. `productId` null means closed empty. */
	| { readonly kind: "pick"; readonly reason: WantReason; readonly path: "activation" | "parked"; readonly productId: number | null; readonly waitMs: number }
	| { readonly kind: "open-attempt"; readonly productId: number; readonly attempt: number; readonly error: string | null }
	| { readonly kind: "opened"; readonly productId: number; readonly productName: string; readonly collections: readonly CollectionReport[] };

/** For lab pages only (docs/units.md U1, U7, U10, U11). The shipped page passes none. */
export interface LabSetup {
	/** From core/protocol `labClearance`, which neither package entry exports. */
	readonly clearance: Clearance;
	/** Wraps each link, e.g. with testing/transcript.ts `recording`, so the session's transcript becomes the capture. */
	readonly wrap: (link: Link) => Link;
	readonly onEvent: (event: PortEvent) => void;
}

/** The page's one way to reach the board. */
export function startWebHid(hid: HID, locks: LockManager, lab?: LabSetup): { readonly kit: Kit; readonly chooser: Chooser } {
	const port = new WebHidPort(hid, locks, lab?.wrap ?? ((link) => link), lab?.onEvent ?? (() => undefined));
	return { kit: createKit(port, lab?.clearance), chooser: port.chooser() };
}

/** For lab pages that drive sessions themselves (docs/units.md U1): the port itself, instead of a kit. The page keeps its clearance. */
export function startWebHidLab(hid: HID, locks: LockManager, setup: Pick<LabSetup, "wrap" | "onEvent">): { readonly port: DevicePort; readonly chooser: Chooser } {
	const port = new WebHidPort(hid, locks, setup.wrap, setup.onEvent);
	return { port, chooser: port.chooser() };
}

/** Which OS refused the device, from the user agent: Linux means the udev rule is missing (R3 O5). */
export function osOf(userAgent: string): "linux" | "other" {
	return /\bLinux\b/.test(userAgent) && !/\bAndroid\b/.test(userAgent) ? "linux" : "other";
}

type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

interface PendingPick {
	readonly want: DeviceWant;
	readonly startedAt: number;
	readonly resolve: (device: HIDDevice) => void;
	readonly reject: (error: unknown) => void;
}

const LOCK_NAME = "tab60kit:device";
/** macOS can refuse the first open right after enumeration; a few retries cover it before the Linux diagnosis applies. */
const OPEN_ATTEMPTS = 5;
const OPEN_RETRY_MS = 200;
const SEND_TIMEOUT_MS = 1_000;
const REPORT_ID = 0;

const browserClock: Clock = {
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

const isSecurityError = (error: unknown): boolean => error instanceof DOMException && error.name === "SecurityError";
const message = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

const reportBytes = (reports: readonly HIDReportInfo[]): number =>
	reports.reduce((total, report) => total + report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) / 8, 0);

const collectionsOf = (device: HIDDevice): CollectionReport[] =>
	device.collections.map((collection) => ({
		usagePage: collection.usagePage,
		usage: collection.usage,
		inputReportBytes: reportBytes(collection.inputReports),
		outputReportBytes: reportBytes(collection.outputReports),
		featureReportBytes: reportBytes(collection.featureReports),
	}));

const hasVendorCollection = (device: HIDDevice): boolean =>
	device.collections.some((collection) => collection.usagePage === TAB60.usagePage && collection.usage === TAB60.usage);

class WebHidPort implements DevicePort {
	#pending: PendingPick | null = null;
	readonly clock = browserClock;

	constructor(
		private readonly hid: HID,
		private readonly locks: LockManager,
		private readonly wrap: (link: Link) => Link,
		private readonly report: (event: PortEvent) => void,
	) {}

	chooser(): Chooser {
		const port = this;
		return {
			pick: () => port.pick(),
			get needsClick() {
				return port.#pending?.want ?? null;
			},
		};
	}

	/**
	 * Answers the parked pick from a click. A chooser closed with no device is a cancelled pick; a chooser that cannot
	 * open at all rejects with the browser's error, so a page cannot loop on a click that never had an activation.
	 */
	pick(): void {
		const pending = this.#pending;
		if (pending === null) return;
		this.#pending = null;
		this.hid.requestDevice({ filters: [...hidFilters(pending.want.modes)] }).then(
			([device]) => {
				this.report({ kind: "pick", reason: pending.want.reason, path: "parked", productId: device?.productId ?? null, waitMs: this.clock.now() - pending.startedAt });
				if (device === undefined) pending.reject(new PickCancelled("the chooser closed with no device"));
				else pending.resolve(device);
			},
			(error: unknown) => pending.reject(error),
		);
	}

	/**
	 * A granted, connected device in one of `want.modes` is reused without a chooser; after any reset the new
	 * connection has no grant (R3 C1, C3), so this finds only the current connection. Otherwise the chooser opens at
	 * once when the click's activation is still live, and stays open to list the bootloader row when the board
	 * re-enumerates (R3 C7). A chooser that closes with no device parks a pick instead of failing, because the row
	 * may not have appeared yet; so does a call with no activation. The UI then shows the device prompt.
	 */
	async open(want: DeviceWant, signal: AbortSignal): Promise<Link> {
		signal.throwIfAborted();
		const device = (await this.granted(want)) ?? (await this.chosen(want, signal));
		return this.wrap(await this.openDevice(device, signal));
	}

	/**
	 * The lock spans the whole job, so a second tab cannot interleave packets into the board's one command buffer.
	 * The job's outcome travels out through `request`, which settles only after the lock is released, so the next
	 * job on this page cannot find its own predecessor still holding the board.
	 */
	async exclusive<T>(job: () => Promise<T>): Promise<T> {
		const settled = await this.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock): Promise<Settled<T>> => {
			if (lock === null) return { ok: false, error: new Busy("another tab or process holds the board") };
			try {
				return { ok: true, value: await job() };
			} catch (error) {
				return { ok: false, error };
			}
		});
		if (settled.ok) return settled.value;
		throw settled.error;
	}

	async granted(want: DeviceWant): Promise<HIDDevice | null> {
		const devices = await this.hid.getDevices();
		return (
			devices.find((device) => {
				const mode = modeOf(device.productId);
				return device.vendorId === TAB60.vendorId && mode !== null && want.modes.includes(mode);
			}) ?? null
		);
	}

	async chosen(want: DeviceWant, signal: AbortSignal): Promise<HIDDevice> {
		const startedAt = this.clock.now();
		try {
			const [device] = await this.hid.requestDevice({ filters: [...hidFilters(want.modes)] });
			this.report({ kind: "pick", reason: want.reason, path: "activation", productId: device?.productId ?? null, waitMs: this.clock.now() - startedAt });
			if (device !== undefined) return device;
		} catch (error) {
			if (!isSecurityError(error)) throw error;
		}
		return this.park(want, signal);
	}

	park(want: DeviceWant, signal: AbortSignal): Promise<HIDDevice> {
		if (this.#pending !== null) throw new Error("a device pick is already pending");
		return new Promise<HIDDevice>((resolve, reject) => {
			const onAbort = () => {
				this.#pending = null;
				reject(signal.reason);
			};
			const settle = <T>(fn: (value: T) => void) => (value: T) => {
				signal.removeEventListener("abort", onAbort);
				fn(value);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.#pending = { want, startedAt: this.clock.now(), resolve: settle(resolve), reject: settle(reject) };
		});
	}

	/** Opens the device, a few tries, then requires the vendor collection. The link's mode comes from the product ID. */
	async openDevice(device: HIDDevice, signal: AbortSignal): Promise<Link> {
		const { productId } = device;
		for (let attempt = 1; ; attempt++) {
			try {
				await device.open();
				this.report({ kind: "open-attempt", productId, attempt, error: null });
				break;
			} catch (error) {
				this.report({ kind: "open-attempt", productId, attempt, error: message(error) });
				if (attempt >= OPEN_ATTEMPTS) throw new OsPermissionDenied(osOf(navigator.userAgent));
				await this.clock.sleep(OPEN_RETRY_MS, signal);
			}
		}
		const mode = modeOf(productId);
		if (!hasVendorCollection(device) || mode === null) {
			await device.close();
			throw new Error(`${device.productName} (0x${productId.toString(16)}) has no vendor collection on usage page 0x${TAB60.usagePage.toString(16)}`);
		}
		this.report({ kind: "opened", productId, productName: device.productName, collections: collectionsOf(device) });
		return new WebHidLink(device, mode, this.hid);
	}
}

/** One HIDDevice connection. Input reports with report ID 0 and 64 bytes queue in order; anything else is ignored. */
class WebHidLink implements Link {
	readonly #queue = new ReportQueue();
	#ended: LinkLost | null = null;
	readonly lost: Promise<void>;
	readonly #settleLost: () => void;
	readonly #lostRejection: Promise<never>;

	constructor(
		private readonly device: HIDDevice,
		readonly mode: Mode,
		private readonly hid: HID,
	) {
		let settle = () => undefined as void;
		this.lost = new Promise<void>((resolve) => {
			settle = resolve;
		});
		this.#settleLost = settle;
		this.#lostRejection = this.lost.then(() => {
			throw this.#ended ?? new LinkLost("the device disconnected");
		});
		this.#lostRejection.catch(() => undefined);
		device.addEventListener("inputreport", this.#onInput);
		hid.addEventListener("disconnect", this.#onDisconnect);
	}

	readonly #onInput = (event: HIDInputReportEvent): void => {
		if (event.reportId !== REPORT_ID || event.data.byteLength !== TAB60.reportBytes) return;
		const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength);
		this.#queue.push(asInReport(Uint8Array.from(bytes)));
	};

	readonly #onDisconnect = (event: HIDConnectionEvent): void => {
		if (event.device !== this.device) return;
		this.#end(new LinkLost("the device disconnected"));
		this.#settleLost();
	};

	#end(error: LinkLost): void {
		if (this.#ended !== null) return;
		this.#ended = error;
		this.#queue.end(error);
		this.device.removeEventListener("inputreport", this.#onInput);
		this.hid.removeEventListener("disconnect", this.#onDisconnect);
	}

	/** Always all 64 bytes: macOS and Linux pass a short report through short (R3). Raced against a timer, because a stale handle may hang. */
	async send(report: OutReport): Promise<void> {
		if (this.#ended !== null) throw this.#ended;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new LinkTimeout(`sendReport did not settle within ${SEND_TIMEOUT_MS} ms`)), SEND_TIMEOUT_MS);
		});
		try {
			await Promise.race([this.device.sendReport(REPORT_ID, Uint8Array.from(report)), timeout, this.#lostRejection]);
		} catch (error) {
			if (error instanceof LinkTimeout || error instanceof LinkLost) throw error;
			throw new LinkLost(`sendReport failed: ${message(error)}`);
		} finally {
			clearTimeout(timer);
		}
	}

	next(timeoutMs: number): Promise<InReport> {
		return this.#queue.next(timeoutMs);
	}

	discardPending(): void {
		this.#queue.discardPending();
	}

	/** Idempotent, and resolves on a lost link: closing a gone device is not an error for the caller. */
	async close(): Promise<void> {
		const wasOpen = this.#ended === null;
		this.#end(new LinkLost("the link was closed"));
		if (!wasOpen) return;
		try {
			await this.device.close();
		} catch {
			// The OS already dropped the device; there is nothing left to close.
		}
	}
}
