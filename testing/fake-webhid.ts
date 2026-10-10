/**
 * WebHID as the shell sees it, over the fake board: a chooser the test or the lab page scripts, a device per
 * enumeration that comes and goes with the board's product ID, input reports as events, and the activation gate
 * requestDevice enforces. Browser-compatible on purpose (EventTarget, DOMException, nothing from Bun or Node): the
 * lab page runs it under ?fake so the flow can be clicked through without a board.
 */
import type { Mode } from "../core/port";
import { FakeTab60, type Plug } from "./fake-tab60";

const VENDOR_ID = 0x04d9;
const PRODUCT_ID: Readonly<Record<Mode, number>> = { app: 0x0304, iap: 0x1304 };
const PRODUCT_NAME: Readonly<Record<Mode, string>> = { app: "USB-HID Keyboard", iap: "USB-HID IAP" };

const REPORT = { reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] } as const;

/** The vendor collection on interface 1: usage page 0xFF00, usage 1, 64-byte input and output reports (R1). */
export const VENDOR_COLLECTION: HIDCollectionInfo = { usagePage: 0xff00, usage: 0x0001, inputReports: [REPORT], outputReports: [REPORT], featureReports: [] };

export interface FakeHidOptions {
	/** Whether a chooser that is already open lists the bootloader row when the board re-enumerates (R3 C7). */
	readonly rowAppearsInOpenChooser: boolean;
	/** Whether a user activation is live when requestDevice is called. Default: the real navigator's, or true outside a browser. */
	readonly isActive?: () => boolean;
	/** How many times device.open() fails with NotAllowedError before it succeeds. Infinity is Linux without the udev rule. */
	readonly openFailures?: number;
	/** The collections every device reports. Default: the vendor collection alone. */
	readonly collections?: readonly HIDCollectionInfo[];
}

class FakeConnectionEvent extends Event implements HIDConnectionEvent {
	constructor(
		type: "connect" | "disconnect",
		readonly device: HIDDevice,
	) {
		super(type);
	}
}

class FakeInputReportEvent extends Event implements HIDInputReportEvent {
	constructor(
		readonly device: HIDDevice,
		readonly reportId: number,
		readonly data: DataView,
	) {
		super("inputreport");
	}
}

type Listener = EventListenerOrEventListenerObject | ((event: never) => void) | null;

const defaultIsActive = (): boolean =>
	typeof navigator !== "undefined" && "userActivation" in navigator ? navigator.userActivation.isActive : true;

const toBytes = (data: BufferSource): Uint8Array =>
	data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

export class FakeHidDevice extends EventTarget implements HIDDevice {
	opened = false;
	connected = true;
	readonly vendorId = VENDOR_ID;
	readonly productId: number;
	readonly productName: string;
	readonly collections: readonly HIDCollectionInfo[];
	#plug: Plug | null = null;
	#openFailuresLeft: number;

	constructor(
		private readonly board: FakeTab60,
		readonly mode: Mode,
		options: FakeHidOptions,
	) {
		super();
		this.productId = PRODUCT_ID[mode];
		this.productName = PRODUCT_NAME[mode];
		this.collections = options.collections ?? [VENDOR_COLLECTION];
		this.#openFailuresLeft = options.openFailures ?? 0;
	}

	// A listener typed for one event narrows the DOM's EventListener, which the implements check rejects; the
	// overloads give callers the typed form and hand EventTarget the general one.
	override addEventListener(type: "inputreport", listener: (this: HIDDevice, event: HIDInputReportEvent) => void): void;
	override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
	override addEventListener(type: string, listener: Listener): void {
		super.addEventListener(type, listener as EventListenerOrEventListenerObject | null);
	}

	override removeEventListener(type: "inputreport", listener: (this: HIDDevice, event: HIDInputReportEvent) => void): void;
	override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
	override removeEventListener(type: string, listener: Listener): void {
		super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null);
	}

	async open(): Promise<void> {
		if (!this.connected || this.#openFailuresLeft > 0) {
			this.#openFailuresLeft--;
			throw new DOMException("Failed to open the device.", "NotAllowedError");
		}
		if (this.opened) throw new DOMException("The device is already open.", "InvalidStateError");
		this.#plug = this.board.plug({
			report: (bytes) => {
				const copy = Uint8Array.from(bytes);
				this.dispatchEvent(new FakeInputReportEvent(this, 0, new DataView(copy.buffer)));
			},
			detached: () => this.disconnect(),
		});
		this.opened = true;
	}

	async close(): Promise<void> {
		this.#plug?.unplug();
		this.#plug = null;
		this.opened = false;
	}

	async sendReport(reportId: number, data: BufferSource): Promise<void> {
		if (!this.opened || this.#plug === null) throw new DOMException("The device must be opened first.", "InvalidStateError");
		if (reportId !== 0) throw new DOMException(`no report ID ${reportId}`, "NotFoundError");
		this.#plug.send(toBytes(data));
	}

	/** The OS lost the device: the board re-enumerated, or the cable came out. */
	disconnect(): void {
		this.connected = false;
		this.opened = false;
		this.#plug?.unplug();
		this.#plug = null;
	}
}

interface OpenChooser {
	readonly filters: readonly HIDDeviceFilter[];
	readonly resolve: (devices: HIDDevice[]) => void;
}

export class FakeHid extends EventTarget implements HID {
	/** The user's answer to each chooser: pick the matching row, or close it. Tests and the lab page flip it between picks. */
	chooser: "pick" | "cancel" = "pick";
	readonly #granted = new Set<FakeHidDevice>();
	readonly #openChoosers: OpenChooser[] = [];
	#device: FakeHidDevice;

	constructor(
		private readonly board: FakeTab60,
		private readonly options: FakeHidOptions,
	) {
		super();
		this.#device = new FakeHidDevice(board, board.mode, options);
		board.onEnumerate((mode) => {
			const old = this.#device;
			old.disconnect();
			this.dispatchEvent(new FakeConnectionEvent("disconnect", old));
			this.#device = new FakeHidDevice(board, mode, options);
			this.dispatchEvent(new FakeConnectionEvent("connect", this.#device));
			for (const open of this.#openChoosers.splice(0)) {
				if (this.#matches(this.#device, open.filters)) open.resolve(this.#answer(this.#device));
				else this.#openChoosers.push(open);
			}
		});
	}

	override addEventListener(type: "connect" | "disconnect", listener: (this: HID, event: HIDConnectionEvent) => void): void;
	override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
	override addEventListener(type: string, listener: Listener): void {
		super.addEventListener(type, listener as EventListenerOrEventListenerObject | null);
	}

	override removeEventListener(type: "connect" | "disconnect", listener: (this: HID, event: HIDConnectionEvent) => void): void;
	override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void;
	override removeEventListener(type: string, listener: Listener): void {
		super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null);
	}

	/** The device the board currently enumerates. */
	get device(): FakeHidDevice {
		return this.#device;
	}

	/** Grants the current device without a chooser, as a pick in an earlier session of the same connection would have. */
	grant(): void {
		this.#granted.add(this.#device);
	}

	async getDevices(): Promise<HIDDevice[]> {
		return [...this.#granted].filter((device) => device.connected);
	}

	async requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]> {
		if (!(this.options.isActive ?? defaultIsActive)()) {
			throw new DOMException("Must be handling a user gesture to show a permission request.", "SecurityError");
		}
		const { filters } = options;
		if (this.#matches(this.#device, filters)) return this.#answer(this.#device);
		if (!this.options.rowAppearsInOpenChooser) return [];
		return new Promise<HIDDevice[]>((resolve) => this.#openChoosers.push({ filters, resolve }));
	}

	#answer(device: FakeHidDevice): HIDDevice[] {
		if (this.chooser === "cancel") return [];
		this.#granted.add(device);
		return [device];
	}

	#matches(device: FakeHidDevice, filters: readonly HIDDeviceFilter[]): boolean {
		return (
			device.connected &&
			filters.some(
				(filter) =>
					(filter.vendorId ?? device.vendorId) === device.vendorId &&
					(filter.productId ?? device.productId) === device.productId &&
					device.collections.some(
						(collection) => (filter.usagePage ?? collection.usagePage) === collection.usagePage && (filter.usage ?? collection.usage) === collection.usage,
					),
			)
		);
	}
}

/** Web Locks for tests and the fake lab page: one lock per name, `ifAvailable` honored, nothing shared across tabs. */
export class FakeLocks implements LockManager {
	readonly #held = new Set<string>();

	request<T>(name: string, callback: LockGrantedCallback<T>): Promise<T>;
	request<T>(name: string, options: LockOptions, callback: LockGrantedCallback<T>): Promise<T>;
	async request<T>(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<T>, maybeCallback?: LockGrantedCallback<T>): Promise<T> {
		const options = typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
		const callback = typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
		if (callback === undefined) throw new TypeError("FakeLocks.request: no callback");
		if (this.#held.has(name)) {
			if (options.ifAvailable) return callback(null);
			throw new Error(`FakeLocks: ${name} is held and the caller did not pass ifAvailable`);
		}
		this.#held.add(name);
		try {
			return await callback({ name, mode: options.mode ?? "exclusive" });
		} finally {
			this.#held.delete(name);
		}
	}

	async query(): Promise<LockManagerSnapshot> {
		return { held: [...this.#held].map((name) => ({ name, mode: "exclusive" as const })), pending: [] };
	}
}
