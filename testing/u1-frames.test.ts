import { expect, test } from "bun:test";
import { connect } from "../core/protocol";
import { FrameNotAllowed, u1Wrap } from "../lab/u1-frames";
import { u1Clearance } from "../lab/u1-job";
import { startWebHidLab } from "../web/webhid-port";
import { TARGET } from "./fake-run";
import { FakeTab60 } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";
import type { TranscriptEntry } from "./transcript";

test("the allowlist refuses a SUM the audit accepts before the transcript or the board sees it", async () => {
	const board = new FakeTab60({ starting: "update-mode-erased", target: TARGET });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["iap"], isActive: () => true });
	const entries: TranscriptEntry[] = [];
	const { port } = startWebHidLab(hid, new FakeLocks(), { wrap: u1Wrap((entry) => entries.push(entry)), onEvent: () => undefined });
	const signal = new AbortController().signal;
	const session = await connect({ port, clearance: u1Clearance(), signal }, { modes: ["iap"], reason: "connect" });
	if ("refusal" in session) throw new Error(session.refusal.code);
	const received = board.packetsReceived;
	const error = await session.checksum(1024, signal).then(
		() => null,
		(rejected: unknown) => rejected,
	);
	const sumOverFirstKilobyte = "1d010000" + "00020000" + "00040000";
	expect(error).toBeInstanceOf(FrameNotAllowed);
	expect(error).toMatchObject({ hex: sumOverFirstKilobyte.padEnd(128, "0") });
	expect(board.packetsReceived).toBe(received);
	expect(entries.filter((entry) => entry.kind === "out" && entry.hex.startsWith("1d01"))).toEqual([]);
	await session.close();
	expect(hid.openHandles).toBe(0);
});
