import { expect, test } from "bun:test";
import { type AppChip, type IapChip, report } from "../core/chip";
import { type FlashableImage, imageBytes } from "../core/firmware";
import type { JobState } from "../core/job";
import { createKit } from "../core/kit";
import { Busy, type DevicePort, PickCancelled } from "../core/port";
import { FlashOrderBroken, connect, labClearance } from "../core/protocol";
import { type TranscriptEntry, recording } from "./transcript";
import { FLASH_CLEARANCE } from "./drop-sweep";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { syntheticFlashable } from "./synthetic-image";

const image = await syntheticFlashable();
const live = new AbortController().signal;
const target = { imageBytes: image.entry.image.bytes, wireSum32: image.entry.image.wireSum32 };
/** A board that starts in update mode with this block over an image summing to the target already holds the target. */
const holdsTarget: Partial<FakeOptions> = { starting: "update-mode-official-image", versionBlock: imageBytes(image).versionBlock.bytes };

function fake(options: Partial<FakeOptions> = {}): FakeTab60 {
	return new FakeTab60({ starting: "official-image", target, clock: "virtual", reenumerateAfterMs: 0, ...options });
}

function watch(kit: { subscribe(listener: (state: JobState) => void): () => void }): string[] {
	const seen: string[] = [];
	kit.subscribe((state) => {
		const label = state.kind === "working" ? state.activity.kind : state.kind;
		if (seen.at(-1) !== label) seen.push(label);
	});
	return seen;
}

const ofCommand = (board: FakeTab60, cmd: number, sub?: number) => board.received.filter((r) => r.cmd === cmd && (sub === undefined || r.sub === sub));

async function bootsTarget(board: FakeTab60, flashed: FlashableImage): Promise<void> {
	expect(await board.bootTarget()).toEqual({ mode: "app", versionPageSha256: flashed.entry.versionBlock.sha256 });
}

test("a flash from normal mode gates the link, erases the version page by its own command first, writes, and comes home checked", async () => {
	const board = fake();
	const kit = createKit(board.port(), FLASH_CLEARANCE);
	const seen = watch(kit);
	const end = await kit.makeOfficial(image);
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official", entry: image.entry, confirmedInNormalMode: true } });
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
	expect(seen).toEqual([
		"awaiting-device",
		"reading",
		"restarting",
		"awaiting-device",
		"restarting",
		"reading",
		"holding-link",
		"erasing",
		"writing-image",
		"reading",
		// Same link as the erase: the gate already passed on it.
		"writing-version-block",
		"reading",
		"restarting",
		"awaiting-device",
		"restarting",
		"reading",
		"finished",
	]);
	const erases = ofCommand(board, 0x1d, 0x00);
	expect(erases).toHaveLength(2);
	const writes = ofCommand(board, 0x1f);
	expect(writes).toHaveLength(Math.ceil(target.imageBytes / 52) + 4);
	expect(writes.at(-1)?.sub).toBe(180 - 3 * 52);
	// Each link gets its own 15 s of answered probes before its first flash write.
	const firstErase = erases[0]?.t ?? 0;
	expect(firstErase).toBeGreaterThanOrEqual(15_000);
});

test("a board that already holds the target is checked in update mode and left alone, unless the caller asks for a rewrite", async () => {
	const holds = fake(holdsTarget);
	const end = await createKit(holds.port(), FLASH_CLEARANCE).makeOfficial(image);
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(ofCommand(holds, 0x1d, 0x00)).toHaveLength(0);
	expect(ofCommand(holds, 0x1f)).toHaveLength(0);

	const rewritten = fake(holdsTarget);
	await createKit(rewritten.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(ofCommand(rewritten, 0x1d, 0x00)).toHaveLength(2);
	expect(rewritten.violations).toEqual([]);
	await bootsTarget(rewritten, image);
});

/** The seven U1 rows and none of the flash rows: what a shipped kit cleared before U7's board run. */
const READS_ONLY = labClearance(["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"], "test");

test("a shipped kit makes official with rewrite off: it flashes a board in normal mode and leaves one that holds the target alone", async () => {
	const board = fake();
	expect(await createKit(board.port()).makeOfficial(image)).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(ofCommand(board, 0x1d, 0x00)).toHaveLength(2);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);

	const holds = fake(holdsTarget);
	expect(await createKit(holds.port()).makeOfficial(image)).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(ofCommand(holds, 0x1d, 0x00)).toHaveLength(0);
	expect(ofCommand(holds, 0x1f)).toHaveLength(0);
});

test("a kit whose clearance lacks the flash rows stops at G1 before it sends anything, so the board stays in normal mode and types", async () => {
	const board = fake();
	const end = await createKit(board.port(), READS_ONLY).makeOfficial(image);
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "gate" } });
	expect(end.kind === "stopped" && end.reason.kind === "gate" ? end.reason.blocked : "").toContain("Erase pages");
	expect(board.received).toEqual([]);
	expect(board.mode).toBe("app");
});

test("a read the board always refuses ends the job within the loss budget", async () => {
	const board = fake({ refuseAlways: { cmd: 0x1d, sub: 0x01 } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image);
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "too-many-link-losses", losses: 11 } });
	expect(ofCommand(board, 0x1d, 0x01).length).toBeLessThanOrEqual(11);
	expect(ofCommand(board, 0x1d, 0x00)).toHaveLength(0);
});

test("an ERASE the board refuses costs one attempt; the retry goes out on a new link only after its own 15 s gate", async () => {
	const board = fake({ refuseOnce: { cmd: 0x1d, sub: 0x00 } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image);
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	const [refused, retried] = ofCommand(board, 0x1d, 0x00);
	if (refused === undefined || retried === undefined) throw new Error("no retry");
	expect(retried.t - refused.t).toBeGreaterThanOrEqual(15_000);
	const probesBetween = board.received.filter((r) => r.cmd === 0x12 && r.sub === 0x02 && r.t > refused.t && r.t < retried.t);
	expect(probesBetween.length).toBeGreaterThanOrEqual(30);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

test("an ERASE refused every time ends with attempts-exhausted, and the board still boots what it had", async () => {
	const board = fake({ refuseAlways: { cmd: 0x1d, sub: 0x00 } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image);
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "attempts-exhausted", step: "erase-and-write-image", attempts: 3 } });
	expect(ofCommand(board, 0x1d, 0x00)).toHaveLength(3);
	expect((await board.bootTarget()).mode).toBe("app");
});

test("an error that means a bug stops the kit with an error state instead of leaving it working", async () => {
	const board = fake();
	const kit = createKit({ ...board.port(), open: async () => Promise.reject(new Error("boom")) }, FLASH_CLEARANCE);
	await expect(kit.check("quick")).rejects.toThrow("boom");
	expect(kit.state).toMatchObject({ kind: "stopped", job: "quick-check", reason: { kind: "error", message: "Error: boom" } });
	await expect(kit.check("quick")).rejects.toThrow("boom");
});

test("no flash write within 15 s of a timeout: a probe that times out restarts the gate on the next link", async () => {
	// The first update-mode READ MODE, inside attach, answers 1.5 s late, past its 1 s timeout.
	const board = fake({ slowOnce: { cmd: 0x12, sub: 0x02, mode: "iap", ms: 1_500 } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image);
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	const slow = board.received.find((r) => r.cmd === 0x12 && r.sub === 0x02 && r.mode === "iap");
	const firstErase = ofCommand(board, 0x1d, 0x00)[0];
	if (slow === undefined || firstErase === undefined) throw new Error("no slow probe or no erase");
	const timeoutAt = slow.t + 1_000;
	expect(firstErase.t - timeoutAt).toBeGreaterThanOrEqual(15_000);
	await bootsTarget(board, image);
});

test("a chooser cancelled right after the reset leaves the board in update mode with its old page; Check reports it and Make official finishes it", async () => {
	const board = fake();
	const base = board.port();
	let cancelled = false;
	const port: DevicePort = {
		...base,
		open: async (want, signal) => {
			if (want.reason !== "enter-update-mode" || cancelled) return base.open(want, signal);
			cancelled = true;
			await board.whenIn(["iap"], signal);
			throw new PickCancelled("the user closed the chooser");
		},
	};
	const kit = createKit(port, FLASH_CLEARANCE);
	const stopped = await kit.makeOfficial(image);
	expect(stopped).toMatchObject({ kind: "stopped", reason: { kind: "cancelled", during: { kind: "restarting", into: "iap" } } });
	expect(board.mode).toBe("iap");

	const checked = await kit.check("quick");
	expect(checked).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "quick" } });
	if (checked.board?.mode !== "iap") throw new Error(`quick check saw ${checked.board?.mode}`);
	expect(checked.board.page).toMatchObject({ kind: "unknown", text: "V1.01.13" });
	expect(report(checked.board).boot).toBe("boots-unchecked-image");

	const finished = await kit.makeOfficial(image);
	expect(finished).toMatchObject({ kind: "finished", result: { kind: "official", confirmedInNormalMode: true } });
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

test("a cancel during the image write stops at the next step boundary, and the next run converges", async () => {
	const board = fake();
	const kit = createKit(board.port(), FLASH_CLEARANCE);
	const off = kit.subscribe((state) => state.kind === "working" && state.activity.kind === "writing-image" && state.activity.chunk === 10 && kit.cancel());
	const stopped = await kit.makeOfficial(image);
	off();
	expect(stopped).toMatchObject({ kind: "stopped", reason: { kind: "cancelled", during: { kind: "writing-image" } } });
	expect(board.mode).toBe("iap");
	expect((await board.bootTarget()).mode).toBe("iap");
	const finished = await kit.makeOfficial(image);
	expect(finished).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

test("the kit runs one job at a time, keeps the session between jobs, and reports Busy from the port's lock", async () => {
	const board = fake();
	const kit = createKit(board.port(), FLASH_CLEARANCE);
	const first = kit.check("quick");
	await expect(kit.check("quick")).rejects.toThrow("a job is running");
	await first;
	const opensBefore = board.received.length;
	await kit.check("quick");
	// The second check reuses the open session: no attach, only the version page.
	expect(board.received.slice(opensBefore).map((r) => r.sub)).toEqual([0x20, 0x21, 0x22]);

	const locked = createKit({ ...board.port(), exclusive: async () => Promise.reject(new Busy("another tab holds the board")) }, FLASH_CLEARANCE);
	expect(await locked.check("quick")).toMatchObject({ kind: "stopped", reason: { kind: "busy" } });
});

test("the deep check comes home from a board that boots, and stays in update mode over an erased page", async () => {
	const boots = fake();
	const kit = createKit(boots.port(), FLASH_CLEARANCE);
	const end = await kit.check("deep");
	expect(end).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "deep" } });
	expect(end.board?.mode).toBe("iap");
	expect(boots.mode).toBe("app");
	expect(ofCommand(boots, 0x1d, 0x01)).toHaveLength(1);

	const erased = fake({ starting: "update-mode-erased" });
	const stays = await createKit(erased.port(), FLASH_CLEARANCE).check("deep");
	expect(stays).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "deep" } });
	if (stays.board === null) throw new Error("no board");
	expect(report(stays.board).boot).toBe("stays-in-update-mode");
	expect(erased.mode).toBe("iap");
	expect(ofCommand(erased, 0x11)).toHaveLength(0);

	// A page cut short has no magic: the IAP would stay in update mode, so the deep check does not try to send it home.
	const partial = fake({ starting: "update-mode-partial-version-block" });
	const left = await createKit(partial.port(), FLASH_CLEARANCE).check("deep");
	expect(left).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "deep" } });
	expect(ofCommand(partial, 0x11)).toHaveLength(0);
});

test("report draws the four regions, fingerprints the bootloader, and splits the app region at the end of an official image", async () => {
	const board = fake(holdsTarget);
	const kit = createKit(board.port(), FLASH_CLEARANCE);
	let inUpdateMode: IapChip | null = null;
	kit.subscribe((state) => {
		if (state.board?.mode === "iap") inUpdateMode = state.board;
	});
	const end = await kit.makeOfficial(image);
	if (end.board?.mode !== "app" || inUpdateMode === null) throw new Error("no observation in each mode");
	const app: AppChip = end.board;
	expect(report(app).regions.map((r) => [r.region, r.finding.kind])).toEqual([
		["bootloader", "not-checkable-over-usb"],
		["version-page", "official"],
		["app", "needs-deep-check"],
		["option-bytes", "not-checkable-over-usb"],
	]);
	const iap: IapChip = inUpdateMode;
	const rows = report(iap).regions;
	expect(rows[0]?.finding).toMatchObject({ kind: "not-checkable-over-usb", fingerprint: iap.blInfoSha256 });
	const imageEnd = 0x3200 + target.imageBytes;
	expect(rows.map((r) => [r.region, r.finding.kind, r.from, r.to])).toEqual([
		["bootloader", "not-checkable-over-usb", 0, 0x3000],
		["version-page", "official", 0x3000, 0x3200],
		["app", "official", 0x3200, imageEnd],
		["app", "not-checked", imageEnd, 0x1fe00],
		["option-bytes", "not-checkable-over-usb", 0x1fe00, 0x20000],
	]);
	expect(report(iap).boot).toBe("normal-mode");

	const deep = await createKit(fake({ starting: "update-mode-erased" }).port(), FLASH_CLEARANCE).check("deep");
	if (deep.board?.mode !== "iap") throw new Error("not in update mode");
	expect(report(deep.board).regions.map((r) => r.finding.kind)).toEqual(["not-checkable-over-usb", "erased", "unrecognized", "not-checkable-over-usb"]);
});

const WINDOW_BYTES = 0x1ce00;
const VERSION_PAGE: readonly [number, number] = [0, 0x200];
const APP_REGION: readonly [number, number] = [0x200, WINDOW_BYTES - 0x200];
const WHOLE_WINDOW: readonly [number, number] = [0, WINDOW_BYTES];
const IMAGE_CHUNKS = Math.ceil(target.imageBytes / 52);
const erasesOf = (board: FakeTab60) => ofCommand(board, 0x1d, 0x00).map((r) => r.words);
/** Each set write address, get write address, and WRITE, as "set 0x200", "get", or "write". */
const cursorTrail = (board: FakeTab60) =>
	board.received.flatMap((r) => (r.cmd === 0x1e ? [r.sub === 0x01 ? `set 0x${r.words[0].toString(16)}` : "get"] : r.cmd === 0x1f ? ["write"] : []));

test("D1: an IAP that refuses the app-region erase with FF AA gets the vendor's one window erase, after the version page is gone", async () => {
	const board = fake({ ...holdsTarget, offsetErase: "error-marker" });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(erasesOf(board)).toEqual([VERSION_PAGE, APP_REGION, WHOLE_WINDOW]);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

test("D1: an IAP that never answers the app-region erase gets it three times, 15 s each, then the window erase", async () => {
	const board = fake({ ...holdsTarget, offsetErase: "silent" });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	const erases = ofCommand(board, 0x1d, 0x00);
	expect(erases.map((r) => r.words)).toEqual([VERSION_PAGE, APP_REGION, APP_REGION, APP_REGION, WHOLE_WINDOW]);
	expect((erases[4]?.t ?? 0) - (erases[1]?.t ?? 0)).toBeGreaterThanOrEqual(3 * 15_000);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

test("D1: no window erase follows a version-page erase that went unanswered; the job reconnects and erases page by page", async () => {
	const board = fake({ ...holdsTarget, offsetErase: "error-marker", slowOnce: { cmd: 0x1d, sub: 0x00, mode: "iap", ms: Number.POSITIVE_INFINITY } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(erasesOf(board)).toEqual([VERSION_PAGE, VERSION_PAGE, APP_REGION, WHOLE_WINDOW]);
	expect(board.violations).toEqual([]);
});

test("D4: every set write address is read back, and a read-back that differs sends the pair again", async () => {
	const board = fake({ ...holdsTarget, cursorFault: { at: 0, times: 2 } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	const trail = cursorTrail(board);
	expect(trail.slice(0, 7)).toEqual(["set 0x200", "get", "set 0x200", "get", "set 0x200", "get", "write"]);
	expect(trail.filter((step) => step.startsWith("set"))).toEqual(["set 0x200", "set 0x200", "set 0x200", "set 0x0"]);
	expect(trail.filter((step) => step === "write")).toHaveLength(IMAGE_CHUNKS + 4);
	await bootsTarget(board, image);
});

test("D4: three read-backs that differ end the step as a refusal; the loop observes, gates a new link, and writes again", async () => {
	const board = fake({ ...holdsTarget, cursorFault: { at: 0, times: 3 } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(erasesOf(board)).toEqual([VERSION_PAGE, APP_REGION, VERSION_PAGE, APP_REGION]);
	expect(cursorTrail(board).slice(0, 7)).toEqual(["set 0x200", "get", "set 0x200", "get", "set 0x200", "get", "set 0x200"]);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

for (const kind of ["no-reply", "mute", "wrong-next"] as const) {
	test(`D5: a WRITE with ${kind} goes again from its block's start, after the cursor is set back and read back`, async () => {
		const board = fake({ ...holdsTarget, writeFault: { at: 100, times: 1, kind } });
		const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
		expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
		const trail = cursorTrail(board);
		const writes = trail.flatMap((step, i) => (step === "write" ? [i] : []));
		const faulty = writes[100] ?? -1;
		expect(trail.slice(faulty, faulty + 4)).toEqual(["write", `set 0x${(0x200 + 100 * 52).toString(16)}`, "get", "write"]);
		expect(writes).toHaveLength(IMAGE_CHUNKS + 4 + 1);
		expect(erasesOf(board)).toHaveLength(2);
		expect(board.violations).toEqual([]);
		await bootsTarget(board, image);
	});
}

test("D5: a block that fails three times hands off to the loop, which erases and writes the image again", async () => {
	const board = fake({ ...holdsTarget, writeFault: { at: 100, times: 3, kind: "wrong-next" } });
	const end = await createKit(board.port(), FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(erasesOf(board)).toEqual([VERSION_PAGE, APP_REGION, VERSION_PAGE, APP_REGION]);
	expect(ofCommand(board, 0x1f)).toHaveLength(100 + 3 + IMAGE_CHUNKS + 4);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

test("a late echo of a timed-out ERASE arrives during the 1 s wait before the resend and is dropped, so the resend waits for its own answer", async () => {
	const board = fake({ ...holdsTarget, slowOnce: { cmd: 0x1d, sub: 0x00, mode: "iap", ms: 15_500, skip: 1 } });
	const entries: TranscriptEntry[] = [];
	const base = board.port();
	const port: DevicePort = { ...base, open: async (want, signal) => recording(await base.open(want, signal), (entry) => entries.push(entry), () => board.clock.now()) };
	const end = await createKit(port, FLASH_CLEARANCE).makeOfficial(image, { rewrite: true });
	expect(end).toMatchObject({ kind: "finished", result: { kind: "official" } });
	expect(erasesOf(board)).toEqual([VERSION_PAGE, APP_REGION, APP_REGION]);
	const appErase = `1d000000${"00020000"}`;
	const [first, second] = entries.flatMap((entry, i) => (entry.kind === "out" && entry.hex.startsWith(appErase) ? [i] : []));
	if (first === undefined || second === undefined) throw new Error("no resend");
	const between = entries.slice(first + 1, second);
	expect(between.map((entry) => entry.kind)).toEqual(["discarded"]);
	expect((entries[second]!.t) - (entries[first]!.t)).toBeGreaterThanOrEqual(15_000 + 1_000);
	expect(entries[second + 1]).toMatchObject({ kind: "in", hex: expect.stringMatching(/^1d000000/) });
	expect((entries[second + 1]!.t) - (entries[second]!.t)).toBeGreaterThan(0);
	expect(board.violations).toEqual([]);
	await bootsTarget(board, image);
});

async function iapSession(options: Partial<FakeOptions>) {
	const board = fake(options);
	const session = await connect({ port: board.port(), clearance: FLASH_CLEARANCE, signal: new AbortController().signal }, { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	return { board, session };
}
const flashFrames = (board: FakeTab60) => board.received.filter((r) => r.cmd === 0x1d && r.sub === 0x00 || r.cmd === 0x1e || r.cmd === 0x1f).length;

test("F4: writeImage throws FlashOrderBroken, sending nothing, unless eraseWindow completed on the same session", async () => {
	const { board, session } = await iapSession({ starting: "update-mode-erased" });
	await expect(session.writeImage(image, () => undefined)).rejects.toBeInstanceOf(FlashOrderBroken);
	expect(flashFrames(board)).toBe(0);
	await session.eraseWindow();
	await session.writeImage(image, () => undefined);
	await expect(session.writeImage(image, () => undefined)).rejects.toThrow("writeImage after image-written");
	await session.close();
});

test("F4: writeVersionBlock throws FlashOrderBroken, sending nothing, unless the session's latest SUM matched the image", async () => {
	const { board, session } = await iapSession({ ...holdsTarget, starting: "update-mode-damaged-image" });
	await expect(session.writeVersionBlock(image)).rejects.toThrow("writeVersionBlock after none");
	await session.checksum(target.imageBytes, live);
	await expect(session.writeVersionBlock(image)).rejects.toThrow(`writeVersionBlock after a SUM of 0x${((target.wireSum32 + 1) >>> 0).toString(16)}`);
	expect(flashFrames(board)).toBe(0);
	await session.eraseWindow();
	await session.writeImage(image, () => undefined);
	await expect(session.writeVersionBlock(image)).rejects.toThrow("writeVersionBlock after image-written");
	await session.checksum(target.imageBytes, live);
	await session.writeVersionBlock(image);
	await session.close();
	expect(board.violations).toEqual([]);
});

test("a shipped kit and the flash clearance list no flash row as blocked, so the page offers Make official; a clearance without them lists all four", () => {
	expect(createKit(fake().port()).capabilities().flashBlockedBy).toEqual([]);
	expect(createKit(fake().port(), FLASH_CLEARANCE).capabilities().flashBlockedBy).toEqual([]);
	const blocked = createKit(fake().port(), READS_ONLY).capabilities().flashBlockedBy;
	expect(blocked).toHaveLength(4);
	expect(blocked[0]).toStartWith("Erase pages: ");
});
