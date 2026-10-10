import { expect, test } from "bun:test";
import { Busy, DeviceAlreadyOpen, LinkLost, LinkTimeout, OpenTimedOut, OsPermissionDenied, PickCancelled } from "../core/port";
import { connect, labClearance } from "../core/protocol";
import { type PortEvent, osOf, startWebHidLab } from "../web/webhid-port";
import { FakeTab60 } from "./fake-tab60";
import { FakeHid, type FakeHidOptions, FakeLocks, VENDOR_COLLECTION } from "./fake-webhid";
import { fromHex } from "./scripted";

const target = { imageBytes: 34_268, wireSum32: 0xf3d3dbd2 };
const clearance = labClearance(["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"], "port test");
const signal = () => new AbortController().signal;
const APP = { modes: ["app"], reason: "connect" } as const;
const IAP = { modes: ["iap"], reason: "enter-update-mode" } as const;

function lab(options: Partial<FakeHidOptions> & { readonly starting?: FakeTab60["options"]["starting"] } = {}) {
	const board = new FakeTab60({ starting: options.starting ?? "official-image", target });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true, ...options });
	const events: PortEvent[] = [];
	const { port, chooser } = startWebHidLab(hid, new FakeLocks(), { wrap: (link) => link, onEvent: (event) => events.push(event) });
	const resetBoard = () => board.plug({ report: () => undefined, detached: () => undefined }).send(fromHex("1100".padEnd(128, "0")));
	return { board, hid, events, port, chooser, resetBoard };
}

const picks = (events: PortEvent[]) => events.filter((event) => event.kind === "pick").map(({ path, productId }) => `${path}:${productId === null ? "none" : productId.toString(16)}`);

test("a live activation opens the chooser at once, and the opened device is reported with its collections", async () => {
	const { port, events, chooser } = lab();
	const link = await port.open(APP, signal());
	expect(link.mode).toBe("app");
	expect(chooser.needsClick).toBeNull();
	expect(picks(events)).toEqual(["activation:304"]);
	expect(events.find((event) => event.kind === "pick")).toMatchObject({ reason: "connect", waitMs: expect.any(Number) });
	expect(events.filter((event) => event.kind === "open-attempt")).toEqual([{ kind: "open-attempt", productId: 0x0304, attempt: 1, error: null }]);
	expect(events.at(-1)).toEqual({
		kind: "opened",
		reason: "connect",
		productId: 0x0304,
		productName: "USB-HID Keyboard",
		collections: [{ usagePage: 0xff00, usage: 1, inputReportBytes: 64, outputReportBytes: 64, featureReportBytes: 0 }],
	});
});

test("without an activation the pick parks until a click answers it", async () => {
	let clicking = false;
	const { port, events, chooser } = lab({ isActive: () => clicking });
	const opening = port.open(APP, signal());
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(chooser.needsClick).toEqual(APP);
	clicking = true;
	chooser.pick();
	const link = await opening;
	expect(link.mode).toBe("app");
	expect(chooser.needsClick).toBeNull();
	expect(picks(events)).toEqual(["parked:304"]);
});

test("a chooser that stays open lists the bootloader row when the board re-enumerates", async () => {
	const { port, events, resetBoard } = lab();
	const opening = port.open(IAP, signal());
	await new Promise((resolve) => setTimeout(resolve, 0));
	resetBoard();
	const link = await opening;
	expect(link.mode).toBe("iap");
	expect(picks(events)).toEqual(["activation:1304"]);
});

test("a chooser that closes empty parks a pick instead of failing, and the click then finds the row", async () => {
	const { port, events, chooser, resetBoard } = lab({ rowAppearsInOpenChooser: [] });
	const opening = port.open(IAP, signal());
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(chooser.needsClick).toEqual(IAP);
	resetBoard();
	await new Promise((resolve) => setTimeout(resolve, 10));
	chooser.pick();
	expect((await opening).mode).toBe("iap");
	expect(picks(events)).toEqual(["activation:none", "parked:1304"]);
});

test("an open chooser for a mode the fake lists waits for its row, and closes empty when none comes", async () => {
	const { port, events, chooser } = lab({ starting: "update-mode-erased", rowAppearsInOpenChooser: ["app"], emptyChooserClosesAfterMs: 20 });
	const opening = port.open(APP, signal());
	opening.catch(() => undefined);
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(picks(events)).toEqual([]);
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(picks(events)).toEqual(["activation:none"]);
	expect(chooser.needsClick).toEqual(APP);
});

test("openHandles counts the open devices across re-enumerations", async () => {
	const { port, hid, resetBoard } = lab();
	const link = await port.open(APP, signal());
	expect(hid.openHandles).toBe(1);
	resetBoard();
	await link.lost;
	expect(hid.openHandles).toBe(0);
	const iap = await port.open(IAP, signal());
	expect(hid.openHandles).toBe(1);
	await iap.close();
	expect(hid.openHandles).toBe(0);
});

test("only a cancelled parked pick is PickCancelled", async () => {
	let clicking = false;
	const { port, hid, chooser, events } = lab({ isActive: () => clicking });
	const opening = port.open(APP, signal());
	await new Promise((resolve) => setTimeout(resolve, 0));
	hid.chooser = "cancel";
	clicking = true;
	chooser.pick();
	await expect(opening).rejects.toBeInstanceOf(PickCancelled);
	expect(picks(events)).toEqual(["parked:none"]);
	expect(chooser.needsClick).toBeNull();
});

test("a click without an activation surfaces the browser's error instead of parking again", async () => {
	const { port, chooser } = lab({ isActive: () => false });
	const opening = port.open(APP, signal());
	await new Promise((resolve) => setTimeout(resolve, 0));
	chooser.pick();
	await expect(opening).rejects.toMatchObject({ name: "SecurityError" });
	expect(chooser.needsClick).toBeNull();
});

test("an aborted signal rejects a parked pick with the signal's reason", async () => {
	const { port, chooser } = lab({ isActive: () => false });
	const controller = new AbortController();
	const opening = port.open(APP, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort(new Error("cancelled by the page"));
	await expect(opening).rejects.toThrow("cancelled by the page");
	expect(chooser.needsClick).toBeNull();
});

test("an abort right after the open starts rejects with its reason, and no chooser opens", async () => {
	const { port, events, hid } = lab();
	const controller = new AbortController();
	const opening = port.open(APP, controller.signal);
	controller.abort(new Error("cancelled from the page"));
	await expect(opening).rejects.toThrow("cancelled from the page");
	expect(picks(events)).toEqual([]);
	expect(hid.device.opened).toBe(false);
});

test("a device picked after the abort is not opened", async () => {
	const { port, events, hid, resetBoard } = lab();
	const controller = new AbortController();
	const opening = port.open(IAP, controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 0));
	controller.abort(new Error("cancelled from the page"));
	resetBoard();
	await expect(opening).rejects.toThrow("cancelled from the page");
	expect(picks(events)).toEqual(["activation:1304"]);
	expect(hid.device.opened).toBe(false);
	expect(events.some((event) => event.kind === "open-attempt")).toBe(false);
});

test("a chooser that closes empty after the abort rejects at once instead of parking", async () => {
	const controller = new AbortController();
	const cancelWhileOpen = () => {
		controller.abort(new Error("cancelled from the page"));
		return true;
	};
	const { port, chooser } = lab({ rowAppearsInOpenChooser: [], isActive: cancelWhileOpen });
	const outcome = await Promise.race([
		port.open(IAP, controller.signal).then(
			() => "opened",
			(error: unknown) => error,
		),
		new Promise((resolve) => setTimeout(() => resolve("still pending"), 200)),
	]);
	expect(outcome).toMatchObject({ message: "cancelled from the page" });
	expect(chooser.needsClick).toBeNull();
});

test("an open that does not settle in 2 s is OpenTimedOut at once, with no retry", async () => {
	const { port, hid, events } = lab();
	hid.device.open = () => new Promise<void>(() => undefined);
	const started = performance.now();
	await expect(port.open(APP, signal())).rejects.toBeInstanceOf(OpenTimedOut);
	expect(performance.now() - started).toBeGreaterThanOrEqual(1_990);
	expect(events.filter((event) => event.kind === "open-attempt").map((event) => event.error?.split(":")[0])).toEqual(["OpenTimedOut"]);
}, 5_000);

test("an open that settles after its timeout is closed again, so nothing holds the device", async () => {
	const { port, hid } = lab();
	const device = hid.device;
	const open = device.open.bind(device);
	device.open = () => new Promise<void>((resolve, reject) => setTimeout(() => open().then(resolve, reject), 2_100));
	await expect(port.open(APP, signal())).rejects.toBeInstanceOf(OpenTimedOut);
	await new Promise((resolve) => setTimeout(resolve, 300));
	expect(device.opened).toBe(false);
}, 6_000);

test("an abort while device.open() is pending closes the device again and reports no open", async () => {
	const { port, hid, events } = lab();
	const device = hid.device;
	const open = device.open.bind(device);
	device.open = () => new Promise<void>((resolve, reject) => setTimeout(() => open().then(resolve, reject), 30));
	const controller = new AbortController();
	const opening = port.open(APP, controller.signal);
	setTimeout(() => controller.abort(new Error("cancelled from the page")), 10);
	await expect(opening).rejects.toThrow("cancelled from the page");
	expect(events.some((event) => event.kind === "opened")).toBe(false);
	expect(hid.openHandles).toBe(0);
});

test("a device this page already holds open is DeviceAlreadyOpen at once, not OsPermissionDenied", async () => {
	const { port, events } = lab();
	await port.open(APP, signal());
	await expect(port.open(APP, signal())).rejects.toBeInstanceOf(DeviceAlreadyOpen);
	const attempts = events.filter((event) => event.kind === "open-attempt");
	expect(attempts.map((event) => (event.error === null ? "ok" : event.error.split(":")[0]))).toEqual(["ok", "InvalidStateError"]);
});

test("a close that does not settle in 2 s counts as closed and reports close-timeout once", async () => {
	const { port, hid, events } = lab();
	const link = await port.open(APP, signal());
	hid.device.close = () => new Promise<void>(() => undefined);
	const started = performance.now();
	await link.close();
	expect(performance.now() - started).toBeGreaterThanOrEqual(1_990);
	await link.close();
	expect(events.filter((event) => event.kind === "close-timeout")).toEqual([{ kind: "close-timeout", productId: 0x0304 }]);
}, 5_000);

test("a device the OS refuses to open is OsPermissionDenied after bounded retries, each reported", async () => {
	const { port, events } = lab({ openFailures: Number.POSITIVE_INFINITY });
	await expect(port.open(APP, signal())).rejects.toBeInstanceOf(OsPermissionDenied);
	const attempts = events.filter((event) => event.kind === "open-attempt");
	expect(attempts.map((event) => event.attempt)).toEqual([1, 2, 3, 4, 5]);
	expect(attempts.every((event) => event.error?.startsWith("NotAllowedError"))).toBe(true);
	expect(events.some((event) => event.kind === "opened")).toBe(false);
});

test("an open that fails right after enumeration is retried", async () => {
	const { port, events } = lab({ openFailures: 2 });
	expect((await port.open(APP, signal())).mode).toBe("app");
	expect(events.filter((event) => event.kind === "open-attempt").map((event) => event.error === null)).toEqual([false, false, true]);
});

test("osOf reads Linux from the user agent and not Android", () => {
	expect(osOf("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36")).toBe("linux");
	expect(osOf("Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0 Mobile")).toBe("other");
	expect(osOf("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0")).toBe("other");
});

test("a granted device without the vendor collection gets no link", async () => {
	const keyboard = { ...VENDOR_COLLECTION, usagePage: 0x0001, usage: 0x0006 };
	const { port, hid, events } = lab({ collections: [keyboard] });
	hid.grant();
	await expect(port.open(APP, signal())).rejects.toThrow(/no vendor collection/);
	expect(picks(events)).toEqual([]);
	expect(hid.device.opened).toBe(false);
});

test("a granted, connected device is reused without a chooser", async () => {
	const { port, events } = lab();
	const first = await port.open(APP, signal());
	await first.close();
	const second = await port.open(APP, signal());
	expect(second.mode).toBe("app");
	expect(picks(events)).toEqual(["activation:304"]);
});

test("the disconnect for this device settles lost and rejects every waiter with LinkLost", async () => {
	const { port, resetBoard } = lab();
	const link = await port.open(APP, signal());
	const waiting = link.next(5_000);
	resetBoard();
	await link.lost;
	await expect(waiting).rejects.toBeInstanceOf(LinkLost);
	await expect(link.next(10)).rejects.toBeInstanceOf(LinkLost);
	await link.close();
	await link.close();
});

test("a sendReport that never settles is a LinkTimeout after one second", async () => {
	const { port, hid } = lab();
	hid.device.sendReport = () => new Promise<void>(() => undefined);
	const started = performance.now();
	await expect(connect({ port, clearance, signal: signal() }, APP)).rejects.toBeInstanceOf(LinkTimeout);
	expect(performance.now() - started).toBeGreaterThanOrEqual(990);
}, 5_000);

test("a second job while one holds the board is Busy", async () => {
	const { port } = lab();
	let release = () => undefined as void;
	const first = port.exclusive(() => new Promise<void>((resolve) => (release = resolve)));
	await expect(port.exclusive(async () => "second")).rejects.toBeInstanceOf(Busy);
	release();
	await first;
	expect(await port.exclusive(async () => "third")).toBe("third");
});

test("the whole bootloader round trip over the fake WebHID lands in update mode and comes back", async () => {
	const { port, events } = lab();
	const ctx = { port, clearance, signal: signal() };
	const app = await connect(ctx, APP);
	if ("refusal" in app) throw new Error(app.refusal.code);
	const iap = await app.enterIap(ctx);
	if ("refusal" in iap) throw new Error(iap.refusal.code);
	expect(Number((await iap.checksum(target.imageBytes, signal())).sum)).toBe(target.wireSum32);
	await iap.exitToApp();
	const back = await connect(ctx, { modes: ["app"], reason: "confirm-normal-mode" });
	expect(back.mode).toBe("app");
	expect(events.filter((event) => event.kind === "opened").map((event) => event.productId)).toEqual([0x0304, 0x1304, 0x0304]);
	expect(picks(events)).toEqual(["activation:304", "activation:1304", "activation:304"]);
});
