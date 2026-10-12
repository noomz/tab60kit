import { expect, test } from "bun:test";
import { U1_FRAMES } from "../lab/u1-frames";
import { recordFakeRun } from "./fake-run";
import { type CancelRecord, type ScenarioResult, owesResetToApp, problems, sweep } from "./u1-sweep";

test("a reduced sweep of link losses and Cancels in every phase finds no problem", async () => {
	const report = await sweep({
		lossAt: [3, 8, 11, 15, 17, 19],
		cancelAfter: [2, 15, 20, 24, 36, 41, 46],
		cancelInRecovery: { restart: [3, 12], "try-again": [3, 20] },
	});
	expect(report.problems).toEqual([]);
	expect(report.scenarios).toBe(26);
	const followed = [...report.afterCancel.keys()].map((key) => key.slice(key.lastIndexOf(": ") + 2));
	expect(new Set(followed)).toEqual(new Set(["nothing", "1101"]));
}, 30_000);

test("a Cancel owes RESET to app from the update-mode open until that frame goes out, and at no other entry", async () => {
	const { entries } = (await recordFakeRun({ series: { probes: 3, everyMs: 1 } })).transcript;
	const owed = entries.flatMap((_, i) => (owesResetToApp(entries.slice(0, i + 1)) ? [i] : []));
	const bootloader = entries.findIndex((entry) => entry.kind === "opened" && entry.productId === 0x1304);
	const reset = entries.findIndex((entry) => entry.kind === "out" && entry.hex.startsWith("1101"));
	expect(owed).toEqual(Array.from({ length: reset - bootloader }, (_, i) => bootloader + i));
});

test("the sweep fails a Cancel that owed RESET to app and sent nothing, and one that owed nothing and sent it", () => {
	const golden = (pair: string) => U1_FRAMES.find((hex) => hex.startsWith(pair)) ?? "";
	const stranded = (cancel: CancelRecord): ScenarioResult => ({
		scenario: { cancelAfter: 30 },
		runs: [
			{ what: "connect", phase: "connected", board: "app", leaked: 0, cancel: null, stuck: false, bringsHome: false },
			{ what: "deep-check", phase: "away", board: "iap", leaked: 0, cancel, stuck: false, bringsHome: false },
			{ what: "restart", phase: "connected", board: "app", leaked: 0, cancel: null, stuck: false, bringsHome: true },
		],
		entries: 60,
		recoveryStart: 0,
		frames: ["1202", "1200", "1100", "1202", "1200", "1201", "1202", "1200", "1201", "1101", "1202", "1200"].map(golden),
		refusedByAllowlist: 0,
		violations: 0,
	});
	const before = { by: "scenario", landed: "in deep-check with an update-mode link open before its RESET to app", owesResetToApp: true } as const;
	const after = { by: "scenario", landed: "in deep-check with an update-mode link open after its RESET to app", owesResetToApp: false } as const;
	expect(problems(stranded({ ...before, framesAfter: [] }))).toEqual(["deep-check sent nothing after a Cancel that owed 1101"]);
	expect(problems(stranded({ ...after, framesAfter: ["1101"] }))).toEqual(["deep-check sent 1101 after a Cancel that owed nothing"]);
	expect(problems(stranded({ ...before, framesAfter: ["1101", "1202"] }))).toEqual(["deep-check sent 1101 1202 after a Cancel that owed 1101"]);
	expect([problems(stranded({ ...before, framesAfter: ["1101"] })), problems(stranded({ ...after, framesAfter: [] }))]).toEqual([[], []]);
});
