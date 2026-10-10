import { expect, test } from "bun:test";
import { sweep } from "./u1-sweep";

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
