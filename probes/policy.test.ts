// Runtime checks of the sketch's implemented pure functions against expectations written independently of them.
// Run: bun test probes/policy.test.ts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";
import { bootTarget } from "../core/chip";
import type { AppChip, IapChip, ImageCheck, PageState } from "../core/chip";
import { udevRules } from "../core/device";
import { CATALOG, imageBytes } from "../core/firmware";
import type { FlashableImage } from "../core/firmware";
import { type LinkEvent, WRITE_LINK_RULE, decideInApp, decideInIap, judgeLink } from "../core/flash";
import type { FlashWindow } from "../core/flashmap";
import { inWindow } from "../core/flashmap";
import { capabilities } from "../core/keymap";
import {
	COMMANDS,
	COMMAND_NAMES,
	type Clearance,
	type CommandName,
	type CommandSpec,
	type EgressContext,
	type Maturity,
	SHIPPED,
	auditEgress,
	clears,
	decodeCommand,
	labClearance,
} from "../core/protocol";

const entry = CATALOG[0]!;
const other = { ...entry, id: "some-other-official-image" };
const target = { entry } as unknown as FlashableImage;
const window = { base: 0x3000, imageBase: 0x3200, end: 0x1fe00, pageSize: 0x200 } as unknown as FlashWindow;
const common = { info: {} as never, window };
let checks = 0;
const check = (name: string, fn: () => void) => {
	test(name, fn);
	checks++;
};

const pages: Record<string, PageState> = {
	target: { kind: "official", entry },
	"other-official": { kind: "official", entry: other },
	erased: { kind: "erased" },
	partial: { kind: "unknown", text: null, sha256: "0".repeat(64) as never },
};
const images: Record<string, ImageCheck> = {
	target: { kind: "official", entry, by: "sum" },
	"other-official": { kind: "official", entry: other, by: "sum" },
	unrecognized: { kind: "unrecognized", sum: 0 as never, crc: null },
};

// Expected next step in update mode, written from R1 "Sequences": prove the image, then write the version block, then boot.
const expected: Record<string, string> = {
	"target/target": "exit-to-app",
	"target/erased": "write-version-block",
	"target/partial": "erase-and-write-image",
	"target/other-official": "erase-and-write-image",
	"other-official/target": "erase-and-write-image",
	"other-official/erased": "erase-and-write-image",
	"other-official/partial": "erase-and-write-image",
	"other-official/other-official": "erase-and-write-image",
	"unrecognized/target": "erase-and-write-image",
	"unrecognized/erased": "erase-and-write-image",
	"unrecognized/partial": "erase-and-write-image",
	"unrecognized/other-official": "erase-and-write-image",
};
for (const [imageName, image] of Object.entries(images)) {
	for (const [pageName, page] of Object.entries(pages)) {
		const chip: IapChip = { mode: "iap", ...common, page, image };
		check(`iap ${imageName}/${pageName}`, () => assert.equal(decideInIap(chip, target, false), expected[`${imageName}/${pageName}`]));
		// A rewrite the caller asked for and this job has not finished comes first, whatever the board holds (U7).
		check(`iap rewrite ${imageName}/${pageName}`, () => assert.equal(decideInIap(chip, target, true), "erase-and-write-image"));
	}
}

// "write-version-block" is the only step that makes the board boot an image; it must require a proven target image.
for (const [imageName, image] of Object.entries(images)) {
	for (const page of Object.values(pages)) {
		for (const rewrite of [false, true]) {
			const step = decideInIap({ mode: "iap", ...common, page, image }, target, rewrite);
			if (step === "write-version-block") {
				check(`version block over image ${imageName}`, () => assert.equal(imageName, "target", "version block written over an unproven image"));
			}
		}
	}
}

// Normal mode: "done" only after this job proved the target in update mode.
const appChip = (page: PageState): AppChip => ({ mode: "app", ...common, page });
check("app: target page, not verified by this job", () => assert.equal(decideInApp(appChip(pages.target!), target, false), "enter-iap"));
check("app: target page, verified by this job", () => assert.equal(decideInApp(appChip(pages.target!), target, true), "done"));
check("app: another official page, verified", () => assert.equal(decideInApp(appChip(pages["other-official"]!), target, true), "enter-iap"));

// The dangerous boot case is named, not hidden.
check("boot: target page over an unrecognized image", () =>
	assert.equal(bootTarget({ mode: "iap", ...common, page: pages.target!, image: images.unrecognized! }), "boots-damaged-image"),
);
check("boot: erased page over the target image", () =>
	assert.equal(bootTarget({ mode: "iap", ...common, page: pages.erased!, image: images.target! }), "stays-in-update-mode"),
);

// The window: [0x3000, 0x1FE00), offsets count from 0x3000, and 32-bit wrap cannot sneak in.
check("window: the V1.01.13 image", () => assert.equal(inWindow(window, 0x200, 34_268), true));
check("window: the whole window", () => assert.equal(inWindow(window, 0, 0x1ce00), true));
check("window: one byte into the option-byte page", () => assert.equal(inWindow(window, 0, 0x1ce01), false));
check("window: an offset that wraps to absolute 0x0", () => assert.equal(inWindow(window, 0xffffd000, 0x3000), false));
check("window: a negative offset", () => assert.equal(inWindow(window, -1, 4), false));
check("window: an empty range", () => assert.equal(inWindow(window, 0x200, 0), false));

// The derived udev rule must equal R3's rule byte for byte (docs/webhid.md "Linux udev rule").
check("udev rule: R3's rule byte for byte", () =>
	assert.equal(
		udevRules(),
		[
			'SUBSYSTEM=="hidraw", ENV{ID_VENDOR_ID}=="04d9", ENV{ID_MODEL_ID}=="0304", ENV{ID_USB_INTERFACE_NUM}=="01", TAG+="uaccess"',
			'SUBSYSTEM=="hidraw", ENV{ID_VENDOR_ID}=="04d9", ENV{ID_MODEL_ID}=="1304", ENV{ID_USB_INTERFACE_NUM}=="01", TAG+="uaccess"',
		].join("\n"),
	),
);

// G1 today, shipped: nothing unlocked, and each config command says what it lacks.
const caps = capabilities(SHIPPED);
check("shipped caps: nothing unlocked", () => assert.deepEqual([caps.canRead, caps.canWrite, caps.canSetOsMode], [false, false, false]));
check("shipped caps: four config commands blocked", () => assert.equal(caps.blockedBy.length, 4));
check("shipped caps: each blocked line asks for review and a capture", () =>
	assert.ok(caps.blockedBy.every((line) => line.includes("needs review and a capture")), caps.blockedBy.join("; ")),
);

// G1 as maturity.
const reviewed: Maturity = { level: "reviewed", by: "user", on: "2026-10-10" };
const confirmed: Maturity = { level: "confirmed", by: "user", on: "2026-10-10", capture: "fixtures/u1-macos.json" };
const unreviewed: Maturity = { level: "unreviewed" };
const lab = labClearance(["readMode"], "test");
const clearing: readonly [Clearance, CommandName, Maturity, boolean, string][] = [
	[SHIPPED, "readMode", unreviewed, false, "shipped, unreviewed"],
	[SHIPPED, "readMode", reviewed, false, "shipped sends no merely reviewed row"],
	[SHIPPED, "readMode", confirmed, true, "shipped sends confirmed rows"],
	[lab, "readMode", unreviewed, false, "a lab session cannot send an unreviewed row it names"],
	[lab, "readMode", reviewed, true, "a lab session sends a reviewed row it names"],
	[lab, "readMode", confirmed, true, "a lab session sends a confirmed row it names"],
	[lab, "erase", confirmed, false, "a lab session sends nothing it does not name, confirmed or not"],
];
for (const [clearance, name, maturity, want, why] of clearing) check(`clearance: ${why}`, () => assert.equal(clears(clearance, name, maturity), want));
const U1_ROWS: readonly CommandName[] = ["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"];
const UNREVIEWED_ROWS: readonly CommandName[] = ["erase", "crc", "setWriteAddress", "write", "cfgReadReverseMap", "cfgSelectLayer", "cfgSetKey", "cfgSetOsMode"];
check("clearance: no lab session before the user's review", () => assert.throws(() => labClearance(["readMode", "erase"], "U7"), /send them: erase$/));
check("clearance: a lab session for the seven confirmed U1 rows", () => assert.equal(labClearance(U1_ROWS, "U1").kind, "lab"));
check("clearance: the shipped build sends exactly the seven U1 rows and refuses erase, crc, set write address, write, and every config row", () =>
	assert.deepEqual(
		{ sends: new Set(COMMAND_NAMES.filter((name) => clears(SHIPPED, name))), refuses: new Set(COMMAND_NAMES.filter((name) => !clears(SHIPPED, name))) },
		{ sends: new Set(U1_ROWS), refuses: new Set(UNREVIEWED_ROWS) },
	),
);
for (const name of UNREVIEWED_ROWS) {
	check(`clearance: no lab session may name ${name}, which is still unreviewed`, () => assert.throws(() => labClearance([name], "test"), new RegExp(`send them: ${name}$`)));
}

// The capture that the confirmed rows cite, from plan U1's run on the user's board on 2026-10-12.
const CAPTURE = "fixtures/u1-macos.json";
const CAPTURE_TRANSCRIPT_SHA256 = "c183362b98cccbebfcbe6517e0e2c3d1ba0c1f412245f20001d69a558cf019e1";
const captures = new Set(
	COMMAND_NAMES.flatMap((name) => {
		const maturity: Maturity = COMMANDS[name].maturity;
		return maturity.level === "confirmed" ? [maturity.capture] : [];
	}),
);
check(`capture: every confirmed row cites ${CAPTURE}`, () => assert.deepEqual(captures, new Set([CAPTURE])));
check(`capture: ${CAPTURE} exists, holds the 2026-10-12 transcript byte for byte, and its verdict passes the frames gate and checks 2 to 9`, () => {
	const path = join(import.meta.dir, "..", CAPTURE);
	assert.ok(existsSync(path), `${CAPTURE} is missing`);
	const fixture: { transcriptFile: string; transcript: unknown; frames: { pass: boolean }; checks: { id: number; pass: boolean }[] } = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(fixture.transcriptFile, "testing/fixtures/tab60kit-u1-2026-10-12T09-07-15-464Z.json");
	// The page saves a transcript as JSON.stringify(transcript, null, 2), so this reproduces the downloaded file's bytes.
	assert.equal(createHash("sha256").update(JSON.stringify(fixture.transcript, null, 2)).digest("hex"), CAPTURE_TRANSCRIPT_SHA256);
	assert.equal(fixture.frames.pass, true);
	assert.deepEqual(
		fixture.checks.filter((result) => result.id !== 1).map((result) => [result.id, result.pass]),
		[2, 3, 4, 5, 6, 7, 8, 9].map((id) => [id, true]),
	);
});

// The registry. No (cmd, sub) pair names two rows; the version-page read covers parts 0..2 and nothing past them.
const overlaps: string[] = [];
for (const cmd of new Set(COMMAND_NAMES.map((name) => COMMANDS[name].cmd))) {
	for (let sub = 0; sub < 256; sub++) {
		const rows = COMMAND_NAMES.filter((name) => {
			const spec: CommandSpec = COMMANDS[name];
			if (spec.cmd !== cmd) return false;
			if (spec.sub === "length") return sub >= 1 && sub <= 52;
			if (typeof spec.sub === "number") return spec.sub === sub;
			return sub >= spec.sub.first && sub < spec.sub.first + spec.sub.count;
		});
		if (rows.length > 1) overlaps.push(`cmd 0x${cmd.toString(16)} sub 0x${sub.toString(16)}: ${rows.join(" and ")}`);
	}
}
check("registry: no (cmd, sub) pair names two rows", () => assert.deepEqual(overlaps, []));
check("registry: READ VERSION PAGE decodes parts 0 to 2 only", () =>
	assert.deepEqual([0x20, 0x21, 0x22, 0x23].map((sub) => decodeCommand(0x12, sub)), ["readVersionPage", "readVersionPage", "readVersionPage", null]),
);
check("registry: WRITE decodes lengths 1 to 52 only", () =>
	assert.deepEqual([0, 1, 52, 53].map((sub) => decodeCommand(0x1f, sub)), [null, "write", "write", null]),
);
check("registry: PING is left out on purpose", () => assert.equal(decodeCommand(0x10, 0x02), null));

// The user's ruling: an erase or write row moves above "unreviewed" only with vendor-updater evidence.
const writeRowProblems = (rows: readonly (readonly [string, CommandSpec])[]) =>
	rows
		.filter(([, spec]) => (spec.effect === "erase" || spec.effect === "write") && spec.maturity.level !== "unreviewed")
		.filter(([, spec]) => spec.evidence.source !== "vendor-updater")
		.map(([name]) => name);
check("registry: erase and write rows above unreviewed cite the vendor updater", () =>
	assert.deepEqual(writeRowProblems(COMMAND_NAMES.map((name) => [name, COMMANDS[name]] as const)), []),
);
const badErase: CommandSpec = { ...COMMANDS.erase, evidence: { source: "pok3rtool", at: "cykb.py:182" }, maturity: reviewed };
check("registry: the rule catches a reviewed erase backed only by pok3rtool", () =>
	assert.deepEqual(writeRowProblems([["erase", badErase]]), ["erase"]),
);

// From R1 "Packet framing", a range is two u32s, a set-address one u32, and WRITE's sub byte is its length.
const PAYLOAD_OF_ADDRESSING = { none: 0, range: 8, "set-cursor": 4, "at-cursor": "sub" } as const;
check("registry: READ MODE waits as long as the link gate's longest probe gap", () =>
	assert.ok(COMMANDS.readMode.timeoutMs >= WRITE_LINK_RULE.maxProbeGapMs, `${COMMANDS.readMode.timeoutMs} ms`),
);
check("registry: each row's payload is exactly its address fields", () =>
	assert.deepEqual(
		COMMAND_NAMES.filter((name) => {
			const spec: CommandSpec = COMMANDS[name];
			return spec.payloadBytes !== PAYLOAD_OF_ADDRESSING[spec.address];
		}),
		[],
	),
);

// The egress audit, on frames built by hand from R1 "Packet framing": cmd, sub, two zero bytes, then LE u32 fields.
const frame = (cmd: number, sub: number, a = 0, b = 0, bytes = 64) => {
	const out = new Uint8Array(bytes);
	const view = new DataView(out.buffer);
	view.setUint8(0, cmd);
	view.setUint8(1, sub);
	if (bytes >= 12) {
		view.setUint32(4, a, true);
		view.setUint32(8, b, true);
	}
	return out;
};
const poke = (bytes: Uint8Array, at: number, value: number) => {
	const out = Uint8Array.from(bytes);
	out[at] = value;
	return out;
};
const iap: EgressContext = { mode: "iap", window, cursor: null, cleared: () => true };
const app: EgressContext = { ...iap, mode: "app" };
const audited = (bytes: Uint8Array, requested: CommandName, ctx: EgressContext = iap) => {
	const verdict = auditEgress(bytes, requested, ctx);
	return verdict.ok ? { ok: verdict.command, cursor: verdict.cursor } : { refused: verdict.refusal.code };
};
const egress: readonly [string, ReturnType<typeof audited>, ReturnType<typeof audited>][] = [
	["SUM over the V1.01.13 image", audited(frame(0x1d, 0x01, 0x200, 34_268), "sum"), { ok: "sum", cursor: null }],
	["ERASE the version page", audited(frame(0x1d, 0x00, 0, 0x200), "erase"), { ok: "erase", cursor: null }],
	["ERASE the app region", audited(frame(0x1d, 0x00, 0x200, 0x1cc00), "erase"), { ok: "erase", cursor: null }],
	["ERASE wrapping to the bootloader", audited(frame(0x1d, 0x00, 0xffffd000, 0x3000), "erase"), { refused: "outside-window" }],
	["ERASE the option-byte page", audited(frame(0x1d, 0x00, 0x1ce00, 0x200), "erase"), { refused: "outside-window" }],
	["ERASE off a page boundary", audited(frame(0x1d, 0x00, 0x100, 0x200), "erase"), { refused: "unaligned-erase" }],
	["an ERASE frame when SUM was asked for", audited(frame(0x1d, 0x00, 0x200, 34_268), "sum"), { refused: "not-requested" }],
	["READ VERSION PAGE part 1", audited(frame(0x12, 0x21), "readVersionPage", { ...iap, mode: "app" }), { ok: "readVersionPage", cursor: null }],
	["READ VERSION PAGE part 3", audited(frame(0x12, 0x23), "readVersionPage", { ...iap, mode: "app" }), { refused: "unknown-command" }],
	["PING", audited(frame(0x10, 0x02), "readMode", { ...iap, mode: "app" }), { refused: "unknown-command" }],
	["READ MODE not cleared", audited(frame(0x12, 0x02), "readMode", { ...iap, cleared: () => false }), { refused: "not-cleared" }],
	["ERASE in normal mode", audited(frame(0x1d, 0x00, 0, 0x200), "erase", { ...iap, mode: "app" }), { refused: "wrong-mode" }],
	["SUM before attach", audited(frame(0x1d, 0x01, 0x200, 4), "sum", { ...iap, window: null }), { refused: "no-window" }],
	["WRITE before a set-address", audited(frame(0x1f, 52), "write"), { refused: "no-write-cursor" }],
	["set the write address to the image", audited(frame(0x1e, 0x01, 0x200), "setWriteAddress"), { ok: "setWriteAddress", cursor: 0x200 }],
	["set the write address in the bootloader", audited(frame(0x1e, 0x01, 0xfffffff0), "setWriteAddress"), { refused: "outside-window" }],
	["WRITE 52 bytes at the image start", audited(frame(0x1f, 52), "write", { ...iap, cursor: 0x200 }), { ok: "write", cursor: 0x234 }],
	["WRITE past the window end", audited(frame(0x1f, 52), "write", { ...iap, cursor: 0x1ce00 - 10 }), { refused: "outside-window" }],
	["a 63-byte frame", audited(frame(0x12, 0x02, 0, 0, 63), "readMode"), { refused: "bad-length" }],
	["READ MODE with 0xBEEF in the crc16 field", audited(poke(poke(frame(0x12, 0x02), 2, 0xef), 3, 0xbe), "readMode", app), { refused: "crc16-field" }],
	["RESET to IAP carrying a payload byte", audited(poke(frame(0x11, 0x00), 4, 0xde), "resetToIap", app), { refused: "payload-overrun" }],
	["READ VERSION PAGE with junk in its last byte", audited(poke(frame(0x12, 0x20), 63, 0x01), "readVersionPage", app), { refused: "payload-overrun" }],
	["SUM with a byte past its range", audited(poke(frame(0x1d, 0x01, 0x200, 34_268), 12, 0x01), "sum"), { refused: "payload-overrun" }],
	["set the write address with a byte past its offset", audited(poke(frame(0x1e, 0x01, 0x200), 8, 0x01), "setWriteAddress"), { refused: "payload-overrun" }],
	["WRITE 20 bytes with its last payload byte set", audited(poke(frame(0x1f, 20), 23, 0xff), "write", { ...iap, cursor: 0x200 }), { ok: "write", cursor: 0x214 }],
	["WRITE 20 bytes with a byte past them", audited(poke(frame(0x1f, 20), 24, 0xff), "write", { ...iap, cursor: 0x200 }), { refused: "payload-overrun" }],
];
for (const [why, actual, want] of egress) check(`egress: ${why}`, () => assert.deepEqual(actual, want));
check("egress: a payload overrun names the first stray byte", () => {
	const verdict = auditEgress(poke(poke(frame(0x1d, 0x01, 0x200, 34_268), 12, 0x01), 40, 0x01), "sum", iap);
	assert.deepEqual(verdict.ok ? null : verdict.refusal, { code: "payload-overrun", at: 12 });
});

// The link gate, on timestamps alone: 15 s of answered probes, at most 1 s apart, and no timeout or loss in them.
const probes = (from: number, to: number, every = 500, skip: (t: number) => boolean = () => false): LinkEvent[] => {
	const out: LinkEvent[] = [];
	for (let t = from; t <= to; t += every) if (!skip(t)) out.push({ t, kind: "probe-ok" });
	return out;
};
const gate: readonly [string, ReturnType<typeof judgeLink>["kind"], LinkEvent[], number][] = [
	["no probes yet", "insufficient", [], 0],
	["15 s of probes every 500 ms", "stable", probes(0, 15_000), 15_000],
	["14 s of probes", "insufficient", probes(0, 14_000), 14_000],
	["a timeout 3 s ago", "unstable", [...probes(0, 15_000), { t: 12_000, kind: "timeout" }], 15_000],
	["a loss 3 s ago", "unstable", [...probes(0, 15_000), { t: 12_000, kind: "lost" }], 15_000],
	["a 2.5 s silence 8 s ago", "insufficient", probes(0, 15_000, 500, (t) => t > 5_000 && t < 7_500), 15_000],
	["the newest probe 2 s old", "insufficient", probes(0, 15_000), 17_000],
	["a loss 20 s ago, then 16 s of probes", "stable", [{ t: -20_000, kind: "lost" }, ...probes(0, 16_000)], 16_000],
	["a loss 16 s ago, probes only since 10 s ago", "insufficient", [{ t: 0, kind: "lost" }, ...probes(6_000, 16_000)], 16_000],
];
for (const [why, want, events, now] of gate) check(`link gate: ${why}`, () => assert.equal(judgeLink(events, now, WRITE_LINK_RULE).kind, want));

// The image handle: a handle admit() did not build has no bytes behind it, and asking for them fails loudly.
check("image handle: no bytes behind a handle admit() did not build", () =>
	assert.throws(() => imageBytes({ entry } as unknown as FlashableImage), /not built by admit/),
);

console.log(
	`policy checks: ${checks} cases (25 update-mode, 3 normal-mode, 2 boot, 6 window, udev rule, 3 G1 caps, ${clearing.length + 3 + UNREVIEWED_ROWS.length} clearance, 2 capture, 8 registry, ${egress.length + 1} egress audit, ${gate.length} link gate, 1 image handle)`,
);
