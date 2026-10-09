/**
 * DevicePort over WebHID. Everything browser-specific lives here and nowhere else: chooser picks and user
 * activation, the input-report queue, disconnect detection, per-call timeouts (Chromium adds none, R3 C12),
 * stale handles, the Linux permission error, and the cross-tab lock.
 *
 * The port never leaves this module. `startWebHid` builds it, hands it to a kit, and returns the kit and a Chooser,
 * so UI code holds neither a DevicePort nor a Link. `WebHidLink.send` is the page's only `sendReport` call, and it
 * accepts only frames the core's egress audit passed (OutReport). probes/boundaries.ts holds both rules.
 *
 * Imports the shell seam (core/port) and the UI entry for createKit. `notImplemented` is the sketch's one exception.
 */
import { type Kit, createKit } from "../core/index";
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
	TAB60,
	asInReport,
	hidFilters,
	modeOf,
} from "../core/port";
import { notImplemented } from "../core/units";

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

/** For lab pages only (docs/units.md U1, U7, U10, U11). The shipped page passes none. */
export interface LabSetup {
	/** From core/protocol `labClearance`, which neither package entry exports. */
	readonly clearance: Clearance;
	/** Wraps each link, e.g. with testing/transcript.ts `recording`, so the session's transcript becomes the capture. */
	readonly wrap: (link: Link) => Link;
}

/** The page's one way to reach the board. */
export function startWebHid(hid: HID, locks: LockManager, lab?: LabSetup): { readonly kit: Kit; readonly chooser: Chooser } {
	const port = new WebHidPort(hid, locks, lab?.wrap ?? ((link) => link));
	return {
		kit: createKit(port, lab?.clearance),
		chooser: {
			pick: () => port.pick(),
			get needsClick() {
				return port.needsClick;
			},
		},
	};
}

interface PendingPick {
	readonly want: DeviceWant;
	readonly resolve: (device: HIDDevice) => void;
	readonly reject: (error: unknown) => void;
}

const browserClock: Clock = {
	now: () => performance.now(),
	sleep: (ms, signal) =>
		new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason);
				},
				{ once: true },
			);
		}),
};

class WebHidPort implements DevicePort {
	#pending: PendingPick | null = null;
	readonly clock = browserClock;

	constructor(
		private readonly hid: HID,
		private readonly locks: LockManager,
		private readonly wrap: (link: Link) => Link,
	) {}

	get needsClick(): DeviceWant | null {
		return this.#pending?.want ?? null;
	}

	/**
	 * TODO: devices = await hid.requestDevice({ filters: hidFilters(pending.want.modes) })
	 *   none picked -> pending.reject(new PickCancelled()); otherwise pending.resolve(devices[0])
	 */
	pick(): void {
		notImplemented(`pick(${this.needsClick?.reason ?? "nothing pending"}) with ${hidFilters.name}, ${PickCancelled.name}`);
	}

	/**
	 * TODO:
	 *   1. A granted, connected device whose product ID is in want.modes: reuse it. After any reset the new
	 *      connection has no grant (R3 C1, C3), so this finds only the current connection.
	 *   2. If the click that started this job is still active (navigator.userActivation.isActive), call
	 *      requestDevice now. For "enter-update-mode" the chooser waits open and adds the "USB-HID IAP" row when the
	 *      board re-enumerates (R3 C7).
	 *   3. Otherwise park a PendingPick and wait for pick() or the signal. The UI shows the device prompt.
	 *   4. device.open(). NotAllowedError on Linux -> OsPermissionDenied("linux"), the missing udev rule (R3 O5).
	 *   5. Require the collection usage page 0xFF00, usage 1, then return this.wrap(new WebHidLink(device, modeOf(productId))).
	 */
	async open(want: DeviceWant, signal: AbortSignal): Promise<Link> {
		return notImplemented(
			`open(${want.modes.join("|")}, aborted=${signal.aborted}) for "${TAB60.productName.iap}" via ${this.hid.requestDevice.name}, ${OsPermissionDenied.name}, ${this.wrap.name}`,
		);
	}

	/**
	 * TODO: locks.request("tab60kit:device", { ifAvailable: true }, (lock) => (lock ? job() : Promise.reject(new Busy())))
	 * The lock spans the whole job, so a second tab cannot interleave packets into the board's one command buffer.
	 */
	async exclusive<T>(job: () => Promise<T>): Promise<T> {
		return notImplemented(`exclusive(${job.name}) via ${typeof this.locks.request}, ${Busy.name}`);
	}
}

/**
 * One HIDDevice connection.
 * TODO:
 *   inputreport (reportId 0, 64 bytes) -> asInReport, then hand to the oldest waiter or queue it
 *   hid "disconnect" for this device -> settle `lost` and reject every waiter with LinkLost
 *   send(r): race device.sendReport(0, r) against a 1 s timer -> LinkTimeout (the handle may be stale)
 *   next(ms): a queued report, or wait up to ms -> LinkTimeout
 *   Always send all 64 bytes. macOS and Linux pass a short report through short (R3).
 */
class WebHidLink implements Link {
	readonly lost: Promise<void> = new Promise<void>(() => {});

	constructor(
		private readonly device: HIDDevice,
		readonly mode: Mode,
	) {}

	async send(report: OutReport): Promise<void> {
		return notImplemented(`send(${report.length}) to ${this.device.productName}, ${LinkTimeout.name}`);
	}

	async next(timeoutMs: number): Promise<InReport> {
		return notImplemented(`next(${timeoutMs}), ${LinkLost.name}, ${asInReport.name}`);
	}

	discardPending(): void {
		notImplemented("discardPending");
	}

	async close(): Promise<void> {
		return notImplemented(`close(${modeOf(this.device.productId) ?? "unknown device"})`);
	}
}
