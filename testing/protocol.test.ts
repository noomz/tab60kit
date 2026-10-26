import { expect, test } from "bun:test";
import type { FlashWindow } from "../core/flashmap";
import { type InReport, LinkLost, LinkTimeout, PickCancelled } from "../core/port";
import {
	COMMANDS,
	COMMAND_NAMES,
	type Clearance,
	type CommandName,
	type CommandSpec,
	DeviceRefused,
	type EgressContext,
	IapAttachFailed,
	ModeDisagrees,
	NotCleared,
	auditEgress,
	clears,
	connect,
	labClearance,
	overrideValueWord,
	parseOverrideEntry,
} from "../core/protocol";
import { usage } from "../core/keymap";
import { BL_INFO_HEX } from "./fixtures";
import { ScriptedLink, ScriptedPort, fromHex, report, scriptedClock, toHex } from "./scripted";

const U1_ROWS = ["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"] as const;
const clearance = labClearance(U1_ROWS, "protocol test");
const live = new AbortController().signal;
const IMAGE_BYTES = 34_268;

const frame = (head: string, payload = "") => (head + "0000" + payload).padEnd(128, "0");
const GOLDEN = {
	readMode: frame("1202"),
	readBlInfo: frame("1200"),
	readFwInfo: frame("1201"),
	readVersionPage0: frame("1220"),
	readVersionPage1: frame("1221"),
	readVersionPage2: frame("1222"),
	sum: frame("1d01", "00020000" + "dc850000"),
	resetToIap: frame("1100"),
	resetToApp: frame("1101"),
} as const;

const modeReply = (mode: "app" | "iap") => report(mode === "app" ? "12020000" + "01" : "12020000" + "00");
const blInfoReply = (hex = BL_INFO_HEX) => report("12000000" + hex);
const fwInfoReply = (payload = "04000200") => report("12010000" + payload);
const pageReply = (part: number) => report(`122${part}0000` + "ab".repeat(60));
const sumReply = report("1d010000" + "d2dbd3f3");

const appAttach = () => [modeReply("app"), blInfoReply()];
const iapAttach = () => [modeReply("iap"), blInfoReply(), fwInfoReply()];
const fwPagesDifferInIap = () => [modeReply("iap"), blInfoReply(BL_INFO_HEX.replace("0002e700", "0002e800")), fwInfoReply()];

const ctx = (port: ScriptedPort, signal = new AbortController().signal, cleared: Clearance = clearance) => ({
	port,
	clearance: cleared,
	signal,
});

test("the nine U1 frames leave the sessions byte for byte", async () => {
	const log: string[] = [];
	const app = new ScriptedLink("app", [...appAttach(), pageReply(0), pageReply(1), pageReply(2), modeReply("app")], log);
	const iap = new ScriptedLink("iap", [...iapAttach(), sumReply, modeReply("iap")], log);
	const port = new ScriptedPort([app, iap], scriptedClock(), log);
	const session = await connect(ctx(port), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const page = await session.readVersionPage(live);
	expect(page.bytes).toHaveLength(180);
	expect(toHex(page.bytes)).toBe("ab".repeat(180));
	await session.probe(live);
	const bootloader = await session.enterIap(ctx(port));
	if ("refusal" in bootloader) throw new Error(bootloader.refusal.code);
	const check = await bootloader.checksum(IMAGE_BYTES, live);
	expect([Number(check.sum), check.crc]).toEqual([0xf3d3dbd2, null]);
	await bootloader.probe(live);
	await bootloader.exitToApp();
	expect(app.sent.map(toHex)).toEqual([
		GOLDEN.readMode,
		GOLDEN.readBlInfo,
		GOLDEN.readVersionPage0,
		GOLDEN.readVersionPage1,
		GOLDEN.readVersionPage2,
		GOLDEN.readMode,
		GOLDEN.resetToIap,
	]);
	expect(iap.sent.map(toHex)).toEqual([GOLDEN.readMode, GOLDEN.readBlInfo, GOLDEN.readFwInfo, GOLDEN.sum, GOLDEN.readMode, GOLDEN.resetToApp]);
	expect(app.closed).toBe(1);
	expect(iap.closed).toBe(1);
	expect(log.indexOf("open iap")).toBeLessThan(log.indexOf("send 1100"));
});

test("discardPending runs before every send, and a reset is never waited on", async () => {
	const app = new ScriptedLink("app", appAttach());
	const port = new ScriptedPort([app, new ScriptedLink("iap", iapAttach())]);
	const session = await connect(ctx(port), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	expect(app.calls).toEqual(["discardPending", "send", "next(1000)", "discardPending", "send", "next(500)"]);
	await session.enterIap(ctx(port));
	expect(app.calls.slice(6)).toEqual(["discardPending", "send", "close"]);
});

test("a late reply to an earlier request is dropped", async () => {
	const app = new ScriptedLink("app", [pageReply(2), ...appAttach()]);
	const session = await connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	expect("refusal" in session).toBe(false);
	expect(app.sent).toHaveLength(2);
	expect(app.calls.filter((call) => call.startsWith("next"))).toHaveLength(3);
});

test("silence past the command's timeout is a LinkTimeout, measured on the port's clock", async () => {
	let t = 0;
	const app = new ScriptedLink("app", [pageReply(2), pageReply(2), pageReply(2)]);
	const port = new ScriptedPort([app], scriptedClock(() => (t += 1_100)));
	await expect(connect(ctx(port), { modes: ["app"], reason: "connect" })).rejects.toBeInstanceOf(LinkTimeout);
	expect(app.calls.filter((call) => call.startsWith("next"))).toEqual(["next(1000)"]);
	expect(app.closed).toBe(1);
});

test("a link that never answers is a LinkTimeout, and the link is closed", async () => {
	const app = new ScriptedLink("app", []);
	await expect(connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" })).rejects.toBeInstanceOf(LinkTimeout);
	expect(app.closed).toBe(1);
});

test("FF AA is a DeviceRefused with the u16 detail at bytes 4..5", async () => {
	const app = new ScriptedLink("app", [modeReply("app"), report("ffaa0000" + "1200")]);
	const failure = connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	await expect(failure).rejects.toBeInstanceOf(DeviceRefused);
	await failure.catch((error: DeviceRefused) => {
		expect(error.command).toBe("readBlInfo");
		expect(error.detail).toBe(0x0012);
	});
	expect(app.closed).toBe(1);
});

test("an FF AA that names another command is not this command's answer, so the wait runs on to its timeout", async () => {
	const app = new ScriptedLink("app", [modeReply("app"), report("ffaa0000" + "1202")]);
	await expect(connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" })).rejects.toBeInstanceOf(LinkTimeout);
	expect(app.closed).toBe(1);
});

test("a command the clearance does not name sends nothing", async () => {
	const reads = { kind: "lab", only: ["readMode", "readBlInfo", "readFwInfo", "readVersionPage"], purpose: "no sum" } as unknown as Clearance;
	const iap = new ScriptedLink("iap", iapAttach());
	const session = await connect(ctx(new ScriptedPort([iap]), undefined, reads), { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const before = iap.sent.length;
	await expect(session.checksum(IMAGE_BYTES, live)).rejects.toBeInstanceOf(NotCleared);
	expect(iap.sent).toHaveLength(before);
	expect(iap.calls.filter((call) => call === "discardPending")).toHaveLength(before);
});

test("the config channel is gated by G1 before anything else happens", async () => {
	const app = new ScriptedLink("app", appAttach());
	const session = await connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await expect(session.config.readLayer0(live)).rejects.toBeInstanceOf(NotCleared);
	await expect(session.config.readKey(1, usage(0x04), live)).rejects.toBeInstanceOf(NotCleared);
	await expect(session.config.setOsMode(1)).rejects.toBeInstanceOf(NotCleared);
	expect(app.sent).toHaveLength(2);
});

const u10 = labClearance(["readMode", "readBlInfo", "cfgReadKeys", "cfgReadKey"], "protocol test");
const words = (...w: number[]) => w.map((word) => (word & 0xff).toString(16).padStart(2, "0") + (word >>> 8).toString(16).padStart(2, "0")).join("");

async function u10Session(replies: InReport[]) {
	const app = new ScriptedLink("app", [...appAttach(), ...replies]);
	const session = await connect(ctx(new ScriptedPort([app]), undefined, u10), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	return { app, session };
}

test("readLayer0 sends frames 0 to 15 of 0x52/0x21 and maps usage 16a + i to word i of frame a", async () => {
	const replies = Array.from({ length: 16 }, (_, a) => report(`5221${a.toString(16).padStart(2, "0")}00` + (a === 2 ? words(0x00ff, 0x0003, 0x0129) : words(...Array(16).fill(0x0003)))));
	const { app, session } = await u10Session(replies);
	const entries = await session.config.readLayer0(live);
	expect(app.sent.slice(2).map(toHex)).toEqual(Array.from({ length: 16 }, (_, a) => `5221${a.toString(16).padStart(2, "0")}00`.padEnd(128, "0")));
	expect(entries.size).toBe(256);
	expect([entries.get(0x20), entries.get(0x21), entries.get(0x22), entries.get(0x23), entries.get(0x00), entries.get(0xff)]).toEqual([
		{ kind: "default" },
		{ kind: "absent" },
		{ kind: "override", code: 0x29, flags: 1 },
		// 0x0000 is an override to code 0, not "absent".
		{ kind: "override", code: 0x00, flags: 0 },
		{ kind: "absent" },
		{ kind: "absent" },
	]);
});

test("readKey sends layer << 8 | usage in bytes 2..3 and parses word 0", async () => {
	const { app, session } = await u10Session([report(`5220e502${words(0x02e4)}`)]);
	expect(await session.config.readKey(2, usage(0xe5), live)).toEqual({ kind: "override", code: 0xe4, flags: 2 });
	expect(toHex(app.sent[2]!)).toBe("5220e502".padEnd(128, "0"));
});

test("a config read skips a reply whose bytes 2..3 do not echo its argument", async () => {
	const { app, session } = await u10Session([report(`52200401${words(0x0005)}`), report(`52200402${words(0x00ff)}`)]);
	expect(await session.config.readKey(2, usage(0x04), live)).toEqual({ kind: "default" });
	expect(app.replies).toHaveLength(0);
	const lone = await u10Session([report(`52200401${words(0x0005)}`)]);
	await expect(lone.session.config.readKey(2, usage(0x04), live)).rejects.toBeInstanceOf(LinkTimeout);
});

test("a config read throws on a word that fits no entry", async () => {
	const { session } = await u10Session([report(`52200400${words(0x0404)}`)]);
	await expect(session.config.readKey(0, usage(0x04), live)).rejects.toBeInstanceOf(RangeError);
});

const u11 = labClearance(["readMode", "readBlInfo", "cfgReadKey", "gateQuery", "gateOpen", "gateClose", "cfgWriteKey"], "protocol test");

async function u11Session(replies: InReport[]) {
	const app = new ScriptedLink("app", [...appAttach(), ...replies]);
	const session = await connect(ctx(new ScriptedPort([app]), undefined, u11), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	return { app, session };
}

test("the gate and the key write are gated by G1 before anything leaves", async () => {
	const { app, session } = await u10Session([]);
	await expect(session.config.queryGate(live)).rejects.toBeInstanceOf(NotCleared);
	await expect(session.config.openGate(live)).rejects.toBeInstanceOf(NotCleared);
	await expect(session.config.closeGate(live)).rejects.toBeInstanceOf(NotCleared);
	await expect(session.config.writeKey(0, usage(0x39), { kind: "default" }, live)).rejects.toBeInstanceOf(NotCleared);
	expect(app.sent).toHaveLength(2);
});

test("queryGate sends 41 FF 00 00 and reads the gate byte from byte 1 and the timer from bytes 2..3", async () => {
	const { app, session } = await u11Session([report("41000000"), report("4101e803")]);
	expect(await session.config.queryGate(live)).toEqual({ gate: 0, timer: 0 });
	expect(await session.config.queryGate(live)).toEqual({ gate: 0x01, timer: 1000 });
	expect(app.sent.slice(2).map(toHex)).toEqual([frame("41ff"), frame("41ff")]);
});

test("openGate sends 41 80 00 00 and closeGate 41 00 00 00, each waiting for its echo", async () => {
	const { app, session } = await u11Session([report("41800000"), report("41ff0000"), report("41000000")]);
	await session.config.openGate(live);
	await session.config.closeGate(live);
	expect(app.sent.slice(2).map(toHex)).toEqual([frame("4180"), frame("4100")]);
	expect(app.replies).toHaveLength(0);
});

test("writeKey sends layer << 8 | usage and the u16 LE value, and returns the entry read back in bytes 4..5", async () => {
	const { app, session } = await u11Session([report(`51203900${words(0x00e0)}`), report(`51203900${words(0x00ff)}`)]);
	expect(await session.config.writeKey(0, usage(0x39), { kind: "override", code: 0xe0, flags: 0 }, live)).toEqual({ kind: "override", code: 0xe0, flags: 0 });
	expect(await session.config.writeKey(0, usage(0x39), { kind: "default" }, live)).toEqual({ kind: "default" });
	expect(app.sent.slice(2).map(toHex)).toEqual(["51203900e000".padEnd(128, "0"), "51203900ff00".padEnd(128, "0")]);
});

test("writeKey on a closed gate throws DeviceRefused with the error marker", async () => {
	const { session } = await u11Session([report("ffaa000051203900")]);
	await expect(session.config.writeKey(0, usage(0x39), { kind: "override", code: 0xe0, flags: 0 }, live)).rejects.toBeInstanceOf(DeviceRefused);
});

test("overrideValueWord maps default to 0x00FF and a code to itself, and refuses 0x03, 0xFF, and non-bytes", () => {
	expect([overrideValueWord({ kind: "default" }), overrideValueWord({ kind: "override", code: 0xe0, flags: 0 }), overrideValueWord({ kind: "override", code: 0, flags: 0 })]).toEqual([0x00ff, 0x00e0, 0x0000]);
	for (const code of [0x03, 0xff, 0x100, -1, 1.5]) expect(() => overrideValueWord({ kind: "override", code, flags: 0 })).toThrow(RangeError);
});

test("a probe that reads the other mode's byte throws ModeDisagrees", async () => {
	const app = new ScriptedLink("app", [...appAttach(), modeReply("iap")]);
	const session = await connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await expect(session.probe(live)).rejects.toBeInstanceOf(ModeDisagrees);
});

const refusals: readonly [string, "app" | "iap", (InReport | Error)[], Record<string, unknown>][] = [
	["READ MODE says update mode on a normal-mode link", "app", [modeReply("iap")], { code: "mode-disagrees", productIdSays: "app", readModeSays: 0 }],
	["READ MODE says normal mode on an update-mode link", "iap", [modeReply("app")], { code: "mode-disagrees", productIdSays: "iap", readModeSays: 1 }],
	["identity bytes differ", "app", [modeReply("app"), blInfoReply(BL_INFO_HEX.replace("d9040413", "d9048212"))], { code: "identity-mismatch" }],
	["fw_offset differs", "app", [modeReply("app"), blInfoReply(BL_INFO_HEX.replace("0002e700", "0004e700"))], { code: "layout-mismatch", field: "fwOffset", got: 0x400 }],
	["fw_pages differs in update mode", "iap", fwPagesDifferInIap(), { code: "layout-mismatch", field: "fwPages", got: 0xe8 }],
];
for (const [why, mode, replies, refusal] of refusals) {
	test(`connect refuses when ${why}`, async () => {
		const link = new ScriptedLink(mode, replies);
		const result = await connect(ctx(new ScriptedPort([link])), { modes: [mode], reason: "connect" });
		if (!("refusal" in result)) throw new Error("connected");
		expect(result.refusal).toMatchObject(refusal);
		expect(result.mode).toBe(mode);
		expect(link.closed).toBe(0);
		if (result.restartToApp === null) {
			expect(mode).toBe("app");
			await result.close();
			expect(link.sent.map((f) => toHex(f.subarray(0, 2)))).not.toContain("1101");
		} else {
			expect(mode).toBe("iap");
			const before = link.sent.length;
			await result.restartToApp();
			expect(link.sent.slice(before).map(toHex)).toEqual([GOLDEN.resetToApp]);
		}
		expect(link.closed).toBe(1);
	});
}

test("a refused update-mode board never receives an addressed command", async () => {
	const iap = new ScriptedLink("iap", fwPagesDifferInIap());
	const result = await connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "connect" });
	if (!("refusal" in result)) throw new Error("connected");
	expect(iap.sent.map((f) => toHex(f.subarray(0, 1)))).toEqual(["12", "12", "12"]);
});

const pairsOf = (link: ScriptedLink) => link.sent.map((f) => toHex(f.subarray(0, 2)));

test("an update-mode attach takes its window from BL info whatever FW INFO answers, and sends FW INFO once", async () => {
	for (const payload of ["04000200", "ff".repeat(60)]) {
		const iap = new ScriptedLink("iap", [modeReply("iap"), blInfoReply(), fwInfoReply(payload)]);
		const session = await connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "enter-update-mode" });
		if ("refusal" in session) throw new Error(`FW INFO ${payload}: ${session.refusal.code}`);
		expect(session.window).toMatchObject({ base: 0x3000, imageBase: 0x3200, end: 0x1fe00, pageSize: 0x200 });
		expect(pairsOf(iap)).toEqual(["1202", "1200", "1201"]);
	}
});

test("enterIap sends no reset when its update-mode open has already failed", async () => {
	const app = new ScriptedLink("app", appAttach());
	const port = new ScriptedPort([app]);
	const session = await connect(ctx(port), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	port.open = async () => {
		throw new PickCancelled("test");
	};
	await expect(session.enterIap(ctx(port))).rejects.toBeInstanceOf(PickCancelled);
	expect(pairsOf(app)).toEqual(["1202", "1200"]);
	expect(app.closed).toBe(1);
});

test("a chooser cancelled after the reset propagates, and the normal-mode link is closed", async () => {
	const app = new ScriptedLink("app", appAttach());
	const port = new ScriptedPort([app]);
	const session = await connect(ctx(port), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	port.open = () => new Promise((_, reject) => setTimeout(() => reject(new PickCancelled("test")), 1));
	await expect(session.enterIap(ctx(port))).rejects.toBeInstanceOf(PickCancelled);
	expect(pairsOf(app)).toEqual(["1202", "1200", "1100"]);
	expect(app.closed).toBe(1);
});

test("a reset whose send fails keeps waiting for the update-mode open and attaches", async () => {
	const app = new ScriptedLink("app", appAttach());
	app.sendError = (frame) => (frame[0] === 0x11 ? new LinkLost("sendReport failed: the device reset") : null);
	const iap = new ScriptedLink("iap", iapAttach());
	const port = new ScriptedPort([app, iap]);
	const session = await connect(ctx(port), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const bootloader = await session.enterIap(ctx(port));
	expect(bootloader.mode).toBe("iap");
	expect("refusal" in bootloader).toBe(false);
	expect(pairsOf(app).at(-1)).toBe("1100");
	expect(app.closed).toBe(1);
	expect(iap.closed).toBe(0);
});

test("a reset the clearance does not name leaves nothing on the wire and closes the session", async () => {
	const noReset = labClearance(["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToApp"], "no reset");
	const app = new ScriptedLink("app", appAttach());
	const port = new ScriptedPort([app, new ScriptedLink("iap", iapAttach())]);
	const session = await connect(ctx(port, undefined, noReset), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await expect(session.enterIap(ctx(port, undefined, noReset))).rejects.toBeInstanceOf(NotCleared);
	expect(pairsOf(app)).toEqual(["1202", "1200"]);
	expect(app.closed).toBe(1);
});

test("an update-mode attach that throws keeps its link open inside IapAttachFailed", async () => {
	const iap = new ScriptedLink("iap", [modeReply("iap")]);
	const failure = connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "enter-update-mode" });
	await expect(failure).rejects.toBeInstanceOf(IapAttachFailed);
	const error = await failure.catch((caught: unknown) => caught);
	if (!(error instanceof IapAttachFailed)) throw new Error("not IapAttachFailed");
	expect(error.cause).toBeInstanceOf(LinkTimeout);
	expect(iap.closed).toBe(0);
	await error.close();
	expect(iap.closed).toBe(1);
	expect(pairsOf(iap)).toEqual(["1202", "1200"]);
});

test("a normal-mode attach that throws closes its link and rethrows the error itself", async () => {
	const app = new ScriptedLink("app", [modeReply("app")]);
	await expect(connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" })).rejects.toBeInstanceOf(LinkTimeout);
	expect(app.closed).toBe(1);
});

test("restartToApp closes the link even when the reset's send fails", async () => {
	const iap = new ScriptedLink("iap", fwPagesDifferInIap());
	iap.sendError = (frame) => (frame[0] === 0x11 ? new LinkLost("unplugged") : null);
	const result = await connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "enter-update-mode" });
	if (!("refusal" in result) || result.restartToApp === null) throw new Error("not an update-mode refusal");
	await expect(result.restartToApp()).rejects.toBeInstanceOf(LinkLost);
	expect(pairsOf(iap).at(-1)).toBe("1101");
	expect(iap.closed).toBe(1);
});

test("after an abort, probe, readVersionPage, and checksum reject with its reason and send nothing", async () => {
	const app = new ScriptedLink("app", appAttach());
	const iap = new ScriptedLink("iap", iapAttach());
	const port = new ScriptedPort([app, iap]);
	const controller = new AbortController();
	const normal = await connect(ctx(port, controller.signal), { modes: ["app"], reason: "connect" });
	const update = await connect(ctx(port, controller.signal), { modes: ["iap"], reason: "connect" });
	if ("refusal" in normal || "refusal" in update) throw new Error("refused");
	const reason = new Error("cancelled from the page");
	controller.abort(reason);
	const sent = [app.sent.length, iap.sent.length];
	await expect(normal.probe(controller.signal)).rejects.toBe(reason);
	await expect(normal.readVersionPage(controller.signal)).rejects.toBe(reason);
	await expect(update.probe(controller.signal)).rejects.toBe(reason);
	await expect(update.readVersionPage(controller.signal)).rejects.toBe(reason);
	await expect(update.checksum(IMAGE_BYTES, controller.signal)).rejects.toBe(reason);
	expect([app.sent.length, iap.sent.length]).toEqual(sent);
});

test("RESET to app still leaves after the job's abort, from a session, a refusal, and a failed attach", async () => {
	const session = new ScriptedLink("iap", iapAttach());
	const refusal = new ScriptedLink("iap", fwPagesDifferInIap());
	const failedAttach = new ScriptedLink("iap", [modeReply("iap")]);
	const port = new ScriptedPort([session, refusal, failedAttach]);
	const controller = new AbortController();
	const job = ctx(port, controller.signal);
	const update = await connect(job, { modes: ["iap"], reason: "connect" });
	const refused = await connect(job, { modes: ["iap"], reason: "enter-update-mode" });
	const failed = await connect(job, { modes: ["iap"], reason: "enter-update-mode" }).catch((error: unknown) => error);
	if ("refusal" in update || !("refusal" in refused) || refused.restartToApp === null || !(failed instanceof IapAttachFailed)) throw new Error("unexpected attach");
	controller.abort(new Error("cancelled from the page"));
	await update.exitToApp();
	await refused.restartToApp();
	await failed.restartToApp();
	expect([session, refusal, failedAttach].map((link) => toHex(link.sent.at(-1) ?? new Uint8Array(0)))).toEqual([GOLDEN.resetToApp, GOLDEN.resetToApp, GOLDEN.resetToApp]);
	expect([session.closed, refusal.closed, failedAttach.closed]).toEqual([1, 1, 1]);
});

const window = { base: 0x3000, imageBase: 0x3200, end: 0x1fe00, pageSize: 0x200 } as unknown as FlashWindow;
const audit = (hex: string, requested: CommandName, mode: "app" | "iap"): string => {
	const context: EgressContext = { mode, window, cursor: 0x200, cleared: (name) => clears(clearance, name) };
	const verdict = auditEgress(fromHex(hex), requested, context);
	return verdict.ok ? "ok" : verdict.refusal.code;
};
const u1Frames: readonly [string, CommandName, readonly ("app" | "iap")[]][] = [
	[GOLDEN.readMode, "readMode", ["app", "iap"]],
	[GOLDEN.readBlInfo, "readBlInfo", ["app", "iap"]],
	[GOLDEN.readFwInfo, "readFwInfo", ["iap"]],
	[GOLDEN.readVersionPage0, "readVersionPage", ["app", "iap"]],
	[GOLDEN.readVersionPage1, "readVersionPage", ["app", "iap"]],
	[GOLDEN.readVersionPage2, "readVersionPage", ["app", "iap"]],
	[GOLDEN.sum, "sum", ["iap"]],
	[GOLDEN.resetToIap, "resetToIap", ["app"]],
	[GOLDEN.resetToApp, "resetToApp", ["iap"]],
];
test("the audit passes the nine U1 frames in their modes only", () => {
	for (const [hex, name, modes] of u1Frames) {
		for (const mode of ["app", "iap"] as const) {
			expect(`${name} in ${mode}: ${audit(hex, name, mode)}`).toBe(`${name} in ${mode}: ${modes.includes(mode) ? "ok" : "wrong-mode"}`);
		}
	}
});

test("the audit refuses every other registry row as not cleared, in both modes", () => {
	const others = COMMAND_NAMES.filter((name) => !(U1_ROWS as readonly CommandName[]).includes(name));
	expect(others).toHaveLength(COMMAND_NAMES.length - 7);
	for (const name of others) {
		const spec: CommandSpec = COMMANDS[name];
		const sub = spec.sub === "length" ? 1 : typeof spec.sub === "number" ? spec.sub : spec.sub.first;
		const hex = frame(spec.cmd.toString(16).padStart(2, "0") + sub.toString(16).padStart(2, "0"), "0000000000020000");
		for (const mode of ["app", "iap"] as const) expect(`${name} in ${mode}: ${audit(hex, name, mode)}`).toBe(`${name} in ${mode}: not-cleared`);
	}
});

test("the audit refuses pairs the registry does not list", () => {
	expect(audit(frame("1223"), "readVersionPage", "app")).toBe("unknown-command");
	expect(audit(frame("12ff"), "readVersionPage", "app")).toBe("unknown-command");
	expect(audit(frame("1002"), "readMode", "app")).toBe("unknown-command");
});

test("parseOverrideEntry reads absent, default, and flags << 8 | code, with any code byte below 0xFF", () => {
	expect([0x0003, 0x00ff, 0x0004, 0x0204, 0x03e7, 0x0103, 0x00f0, 0x03e8, 0x02fe].map(parseOverrideEntry)).toEqual([
		{ kind: "absent" },
		{ kind: "default" },
		{ kind: "override", code: 0x04, flags: 0 },
		{ kind: "override", code: 0x04, flags: 2 },
		{ kind: "override", code: 0xe7, flags: 3 },
		{ kind: "override", code: 0x03, flags: 1 },
		{ kind: "override", code: 0xf0, flags: 0 },
		{ kind: "override", code: 0xe8, flags: 3 },
		{ kind: "override", code: 0xfe, flags: 2 },
	]);
});

test("parseOverrideEntry throws on flags above 3, on code 0xFF with flags set, and on a non-u16", () => {
	for (const word of [0x0400, 0x0404, 0xff04, 0x01ff, 0x03ff, 0x10000, -1, 1.5]) {
		expect(() => parseOverrideEntry(word)).toThrow(RangeError);
	}
});
