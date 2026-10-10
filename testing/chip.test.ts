import { expect, test } from "bun:test";
import { classifyPage, leaveUpdateMode, observe } from "../core/chip";
import { CATALOG } from "../core/firmware";
import type { Activity } from "../core/job";
import { PickCancelled } from "../core/port";
import { connect, labClearance } from "../core/protocol";
import { BL_INFO_HEX, VERSION_PAGE_HEX } from "./fixtures";
import { ScriptedLink, ScriptedPort, fromHex, report, toHex } from "./scripted";

const clearance = labClearance(["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"], "chip test");
const entry = CATALOG[0]!;
const page = fromHex(VERSION_PAGE_HEX);
const pageReplies = (bytes: Uint8Array) => [0, 1, 2].map((part) => report(`122${part}0000` + toHex(bytes.subarray(part * 60, part * 60 + 60))));
const sumReply = (sum: number) => report("1d010000" + toHex(fromHex(sum.toString(16).padStart(8, "0")).reverse()));
const ctx = (port: ScriptedPort, progress: Activity[] = []) => ({
	port,
	clearance,
	signal: new AbortController().signal,
	progress: (activity: Activity) => {
		progress.push(activity);
	},
});

test("classifyPage: erased, unknown with its version text, and the hash it carries", async () => {
	expect(await classifyPage({ bytes: new Uint8Array(180).fill(0xff) })).toEqual({ kind: "erased" });
	const state = await classifyPage({ bytes: page });
	expect(state).toMatchObject({ kind: "unknown", text: "V1.01.13" });
	if (state.kind !== "unknown") throw new Error(state.kind);
	expect(state.sha256).toMatch(/^[0-9a-f]{64}$/);
	expect(state.sha256).not.toBe(entry.versionBlock.sha256);
});

test("classifyPage: a length word past the fixed words gives no text", async () => {
	const torn = Uint8Array.from(page);
	torn.set([0x80, 0x00, 0x00, 0x00], 0);
	expect(await classifyPage({ bytes: torn })).toMatchObject({ kind: "unknown", text: null });
});

test("observe in normal mode reads the version page and nothing else", async () => {
	const app = new ScriptedLink("app", [report("1202000001"), report("12000000" + BL_INFO_HEX), ...pageReplies(page)]);
	const session = await connect(ctx(new ScriptedPort([app])), { modes: ["app"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const observed = await observe(session);
	expect(observed.mode).toBe("app");
	expect(observed.chip.page).toMatchObject({ kind: "unknown", text: "V1.01.13" });
	expect(app.sent.map((f) => toHex(f.subarray(0, 2)))).toEqual(["1202", "1200", "1220", "1221", "1222"]);
});

test("observe in update mode sums the catalog's image length and recognizes the official sum", async () => {
	const iap = new ScriptedLink("iap", [report("1202000000"), report("12000000" + BL_INFO_HEX), report("1201000000020000"), ...pageReplies(page), sumReply(0xf3d3dbd2)]);
	const session = await connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const observed = await observe(session);
	if (observed.mode !== "iap") throw new Error(observed.mode);
	expect(observed.chip.image).toEqual({ kind: "official", entry, by: "sum" });
	expect(iap.sent.map((f) => toHex(f.subarray(0, 2)))).toEqual(["1202", "1200", "1201", "1220", "1221", "1222", "1d01"]);
	expect(toHex(iap.sent[6]!.subarray(4, 12))).toBe("00020000dc850000");
});

test("observe in update mode reports an unrecognized sum", async () => {
	const iap = new ScriptedLink("iap", [report("1202000000"), report("12000000" + BL_INFO_HEX), report("1201000000020000"), ...pageReplies(page), sumReply(0x12345678)]);
	const session = await connect(ctx(new ScriptedPort([iap])), { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const observed = await observe(session);
	if (observed.mode !== "iap") throw new Error(observed.mode);
	const { image } = observed.chip;
	if (image.kind !== "unrecognized") throw new Error(image.kind);
	expect([Number(image.sum), image.crc]).toEqual([0x12345678, null]);
});

test("leaveUpdateMode resets into normal mode, then confirms with a normal-mode session", async () => {
	const iap = new ScriptedLink("iap", [report("1202000000"), report("12000000" + BL_INFO_HEX), report("1201000000020000")]);
	const app = new ScriptedLink("app", [report("1202000001"), report("12000000" + BL_INFO_HEX)]);
	const port = new ScriptedPort([iap, app]);
	const progress: Activity[] = [];
	const session = await connect(ctx(port), { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const back = await leaveUpdateMode(session, ctx(port, progress));
	expect(back?.mode).toBe("app");
	expect(progress).toEqual([{ kind: "restarting", into: "app" }]);
	expect(iap.sent.map((f) => toHex(f.subarray(0, 2))).at(-1)).toBe("1101");
	expect(iap.closed).toBe(1);
	expect(port.opens.at(-1)).toEqual({ modes: ["app"], reason: "confirm-normal-mode" });
});

test("leaveUpdateMode treats a cancelled confirm pick as Skip", async () => {
	const iap = new ScriptedLink("iap", [report("1202000000"), report("12000000" + BL_INFO_HEX), report("1201000000020000")]);
	const port = new ScriptedPort([iap]);
	const session = await connect(ctx(port), { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	port.open = async () => {
		throw new PickCancelled("closed the chooser");
	};
	expect(await leaveUpdateMode(session, ctx(port))).toBeNull();
	expect(iap.closed).toBe(1);
});
