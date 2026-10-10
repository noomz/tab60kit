import { expect, test } from "bun:test";
import type { FlashWindow } from "../core/flashmap";
import { type InReport, LinkTimeout, PickCancelled } from "../core/port";
import {
	COMMANDS,
	COMMAND_NAMES,
	type Clearance,
	type CommandName,
	type CommandSpec,
	DeviceRefused,
	type EgressContext,
	ModeDisagrees,
	NotCleared,
	auditEgress,
	clears,
	connect,
	labClearance,
} from "../core/protocol";
import { BL_INFO_HEX } from "./fixtures";
import { ScriptedLink, ScriptedPort, fromHex, report, scriptedClock, toHex } from "./scripted";

const U1_ROWS = ["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"] as const;
const clearance = labClearance(U1_ROWS, "protocol test");
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
const fwInfoReply = (offset = 0x200) => report("12010000" + toHex(fromHex(offset.toString(16).padStart(8, "0")).reverse()));
const pageReply = (part: number) => report(`122${part}0000` + "ab".repeat(60));
const sumReply = report("1d010000" + "d2dbd3f3");

const appAttach = () => [modeReply("app"), blInfoReply()];
const iapAttach = () => [modeReply("iap"), blInfoReply(), fwInfoReply()];

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
	const page = await session.readVersionPage();
	expect(page.bytes).toHaveLength(180);
	expect(toHex(page.bytes)).toBe("ab".repeat(180));
	await session.probe();
	const bootloader = await session.enterIap(ctx(port));
	if ("refusal" in bootloader) throw new Error(bootloader.refusal.code);
	const check = await bootloader.checksum(IMAGE_BYTES);
	expect([Number(check.sum), check.crc]).toEqual([0xf3d3dbd2, null]);
	await bootloader.probe();
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

test("a command the clearance does not name sends nothing", async () => {
	const reads = { kind: "lab", only: ["readMode", "readBlInfo", "readFwInfo", "readVersionPage"], purpose: "no sum" } as unknown as Clearance;
	const iap = new ScriptedLink("iap", iapAttach());
	const session = await connect(ctx(new ScriptedPort([iap]), undefined, reads), { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const before = iap.sent.length;
	await expect(session.checksum(IMAGE_BYTES)).rejects.toBeInstanceOf(NotCleared);
	expect(iap.sent).toHaveLength(before);
	expect(iap.calls.filter((call) => call === "discardPending")).toHaveLength(before);
});

test("the config channel is gated by G1 before anything else happens", async () => {
	const app = new ScriptedLink("app", appAttach());
	const session = await connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await expect(session.config.readLayer(0)).rejects.toBeInstanceOf(NotCleared);
	await expect(session.config.setOsMode(1)).rejects.toBeInstanceOf(NotCleared);
	expect(app.sent).toHaveLength(2);
});

test("a probe that reads the other mode's byte throws ModeDisagrees", async () => {
	const app = new ScriptedLink("app", [...appAttach(), modeReply("iap")]);
	const session = await connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await expect(session.probe()).rejects.toBeInstanceOf(ModeDisagrees);
});

const refusals: readonly [string, "app" | "iap", (InReport | Error)[], Record<string, unknown>][] = [
	["READ MODE says update mode on a normal-mode link", "app", [modeReply("iap")], { code: "mode-disagrees", productIdSays: "app", readModeSays: 0 }],
	["READ MODE says normal mode on an update-mode link", "iap", [modeReply("app")], { code: "mode-disagrees", productIdSays: "iap", readModeSays: 1 }],
	["identity bytes differ", "app", [modeReply("app"), blInfoReply(BL_INFO_HEX.replace("d9040413", "d9048212"))], { code: "identity-mismatch" }],
	["fw_offset differs", "app", [modeReply("app"), blInfoReply(BL_INFO_HEX.replace("0002e700", "0004e700"))], { code: "layout-mismatch", field: "fwOffset", got: 0x400 }],
	["FW INFO disagrees with BL info", "iap", [modeReply("iap"), blInfoReply(), fwInfoReply(0x400)], { code: "fw-info-disagrees", blInfoFwOffset: 0x200, fwInfoOffset: 0x400 }],
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
	const iap = new ScriptedLink("iap", [modeReply("iap"), blInfoReply(), fwInfoReply(0x400)]);
	const result = await connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "connect" });
	if (!("refusal" in result)) throw new Error("connected");
	expect(iap.sent.map((f) => toHex(f.subarray(0, 1)))).toEqual(["12", "12", "12"]);
});

test("enterIap propagates a cancelled chooser and leaves the normal-mode link closed", async () => {
	const app = new ScriptedLink("app", appAttach());
	const port = new ScriptedPort([app]);
	port.open = async (want) => {
		if (want.modes.includes("iap")) throw new PickCancelled("test");
		return app;
	};
	const session = await connect(ctx(port), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	await expect(session.enterIap(ctx(port))).rejects.toBeInstanceOf(PickCancelled);
	expect(app.sent.map((f) => toHex(f.subarray(0, 2)))).toContain("1100");
	expect(app.closed).toBe(1);
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
