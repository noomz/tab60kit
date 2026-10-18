import { expect, test } from "bun:test";
import { type AppChip, type IapChip, report } from "../core/chip";
import { type FlashableImage, imageBytes } from "../core/firmware";
import type { JobState } from "../core/job";
import { createKit } from "../core/kit";
import { Busy, type DevicePort, PickCancelled } from "../core/port";
import { FLASH_CLEARANCE } from "./drop-sweep";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { syntheticFlashable } from "./synthetic-image";

const image = await syntheticFlashable();
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

test("a shipped kit stops at G1 before the first erase leaves, and the board keeps its image", async () => {
	const board = fake();
	const end = await createKit(board.port()).makeOfficial(image);
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "gate" } });
	expect(end.kind === "stopped" && end.reason.kind === "gate" ? end.reason.blocked : "").toContain("Erase pages");
	expect(ofCommand(board, 0x1d, 0x00)).toHaveLength(0);
	expect(ofCommand(board, 0x1e)).toHaveLength(0);
	expect(board.violations).toEqual([]);
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
