import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateU1 } from "../lab/u1-checks";
import { U1_EXPECTED } from "../lab/u1-job";
import { verdictMain } from "../tools/u1-verdict";
import { parseTranscript } from "./transcript";

const SESSION = join(import.meta.dir, "fixtures", "tab60kit-u1-2026-10-10T12-16-20-942Z.json");
const raw: unknown = JSON.parse(readFileSync(SESSION, "utf8"));

const CHECKS = [
	[1, false, "needed a second click: the activation chooser closed with no device, the parked pick chose 0x1304"],
	[2, true, "USB-HID IAP: 0xff00/1 in 64 out 64 feature 0"],
	[3, true, "normal mode answered {1}, update mode answered {0} over 67 reads"],
	[4, true, "fw_offset 0x200, page_size 0x200, fw_pages 0xe7, identity 00000000d904041340700404ffffffff"],
	[5, false, "0x00020004"],
	[6, true, "2 reads hashed to ca529cf626ef0b18877dcced28a91cad6f58d085473bcc2330b6df845439d345"],
	[7, false, "no SUM over the image range answered"],
	[8, true, "RESET to app sent; the confirm pick (activation) opened 0x0304; typing confirmed"],
	[
		9,
		false,
		"normal mode: 30 in a row, all answered, longest gap 1451 ms, slowest answer 5 ms, shortest send gap 503 ms; update mode: 1 in a row, all answered, longest gap 0 ms, slowest answer 4 ms, shortest send gap Infinity ms",
	],
];

test("the first hardware session's transcript still parses whole, and its verdict has not changed", async () => {
	const transcript = parseTranscript(raw);
	expect(raw).toStrictEqual(transcript);
	const verdict = await evaluateU1(transcript, { expected: U1_EXPECTED, typing: "types" });
	expect(verdict.frames).toEqual({ title: "Every frame sent is one of the nine golden frames", pass: true, detail: "all 87 out entries are golden" });
	expect(verdict.checks.map((check) => [check.id, check.pass, check.detail])).toEqual(CHECKS);
	expect(verdict.findings).toEqual(["the tab was hidden 26 times, and a hidden tab slows timers, so check 9's timing may measure the tab"]);
	expect(verdict.commands).toEqual(["12/02", "12/00", "12/20", "12/21", "12/22", "11/00", "12/01", "11/01"]);
});

test("the verdict CLI still takes the first hardware session as evidence, writes its fixture, and exits 1 on its failing checks", async () => {
	const dir = mkdtempSync(join(tmpdir(), "u1-hardware-"));
	const log = spyOn(console, "log").mockImplementation(() => undefined);
	try {
		const out = join(dir, "u1-macos.json");
		expect(await verdictMain([SESSION, "--types", "--out", out])).toBe(1);
		expect(existsSync(out)).toBe(true);
		const fixture = JSON.parse(readFileSync(out, "utf8"));
		expect(fixture.checks.map((check: { id: number; pass: boolean; detail: string }) => [check.id, check.pass, check.detail])).toEqual(CHECKS);
		expect(fixture.frames.pass).toBe(true);
	} finally {
		log.mockRestore();
		rmSync(dir, { recursive: true, force: true });
	}
});
