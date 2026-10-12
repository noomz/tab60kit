import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateU1 } from "../lab/u1-checks";
import { U1_EXPECTED } from "../lab/u1-job";
import { verdictMain } from "../tools/u1-verdict";
import { parseTranscript } from "./transcript";

interface Session {
	readonly name: string;
	readonly verdict: string;
	readonly file: string;
	readonly sha256: string;
	readonly golden: number;
	readonly checks: [number, boolean, string][];
	readonly findings: readonly string[];
	readonly commands: readonly string[];
}

const NINE = ["12/02", "12/00", "12/20", "12/21", "12/22", "11/00", "12/01", "1d/01", "11/01"];

const SESSIONS: readonly Session[] = [
	{
		name: "session 1 (2026-10-10)",
		verdict: "fails only checks 1, 7, and 9, with check 5 passing on the board's own FW INFO answer",
		file: "tab60kit-u1-2026-10-10T12-16-20-942Z.json",
		sha256: "0be650df0c755df2bd06f6982ddb45437422fe2055953a6b669860127ae47e36",
		golden: 87,
		checks: [
			[1, false, "needed a second click: the activation chooser closed with no device, the parked pick chose 0x1304"],
			[2, true, "USB-HID IAP: 0xff00/1 in 64 out 64 feature 0"],
			[3, true, "normal mode answered {1}, update mode answered {0} over 67 reads"],
			[4, true, "fw_offset 0x200, page_size 0x200, fw_pages 0xe7, identity 00000000d904041340700404ffffffff"],
			[5, true, "3 reads answered 04000200 and 56 zero bytes"],
			[6, true, "2 reads hashed to ca529cf626ef0b18877dcced28a91cad6f58d085473bcc2330b6df845439d345"],
			[7, false, "no SUM over the image range answered"],
			[8, true, "RESET to app sent; the confirm pick (activation) opened 0x0304; typing confirmed"],
			[
				9,
				false,
				"normal mode: 30 in a row, all answered, longest gap 1451 ms, slowest answer 5 ms, shortest send gap 503 ms; update mode: 1 in a row, all answered, longest gap 0 ms, slowest answer 4 ms, shortest send gap Infinity ms",
			],
		],
		findings: ["the tab was hidden 26 times, and a hidden tab slows timers, so check 9's timing may measure the tab"],
		commands: ["12/02", "12/00", "12/20", "12/21", "12/22", "11/00", "12/01", "11/01"],
	},
	{
		name: "session 2 (2026-10-12)",
		verdict: "fails only check 9, on an update-mode gap of 1094 ms while the tab was hidden",
		file: "tab60kit-u1-2026-10-12T09-02-24-367Z.json",
		sha256: "ad091359d8c4ab124d34c9752bda4ec6a40f625921ecb1c57e8351b7c2543fbb",
		golden: 76,
		checks: [
			[1, true, "picked 0x1304 inside the click's activation after 2606 ms"],
			[2, true, "USB-HID IAP: 0xff00/1 in 64 out 64 feature 0"],
			[3, true, "normal mode answered {1}, update mode answered {0} over 63 reads"],
			[4, true, "fw_offset 0x200, page_size 0x200, fw_pages 0xe7, identity 00000000d904041340700404ffffffff"],
			[5, true, "1 reads answered 04000200 and 56 zero bytes"],
			[6, true, "2 reads hashed to ca529cf626ef0b18877dcced28a91cad6f58d085473bcc2330b6df845439d345"],
			[7, true, "0xf3d3dbd2"],
			[8, true, "RESET to app sent; the confirm pick (parked) opened 0x0304; typing confirmed"],
			[
				9,
				false,
				"normal mode: 30 in a row, all answered, longest gap 506 ms, slowest answer 4 ms, shortest send gap 503 ms; update mode: 30 in a row, all answered, longest gap 1094 ms, slowest answer 5 ms, shortest send gap 504 ms",
			],
		],
		findings: ["the tab was hidden 4 times, and a hidden tab slows timers, so check 9's timing may measure the tab"],
		commands: NINE,
	},
	{
		name: "run 3 (2026-10-12)",
		verdict: "fails only check 1, where the activation chooser closed with no device after 322 ms and the parked pick chose the bootloader",
		file: "tab60kit-u1-2026-10-12T09-07-15-464Z.json",
		sha256: "c183362b98cccbebfcbe6517e0e2c3d1ba0c1f412245f20001d69a558cf019e1",
		golden: 76,
		checks: [
			[1, false, "needed a second click: the activation chooser closed with no device, the parked pick chose 0x1304"],
			[2, true, "USB-HID IAP: 0xff00/1 in 64 out 64 feature 0"],
			[3, true, "normal mode answered {1}, update mode answered {0} over 63 reads"],
			[4, true, "fw_offset 0x200, page_size 0x200, fw_pages 0xe7, identity 00000000d904041340700404ffffffff"],
			[5, true, "1 reads answered 04000200 and 56 zero bytes"],
			[6, true, "2 reads hashed to ca529cf626ef0b18877dcced28a91cad6f58d085473bcc2330b6df845439d345"],
			[7, true, "0xf3d3dbd2"],
			[8, true, "RESET to app sent; the confirm pick (activation) opened 0x0304; typing confirmed"],
			[
				9,
				true,
				"normal mode: 30 in a row, all answered, longest gap 508 ms, slowest answer 6 ms, shortest send gap 503 ms; update mode: 30 in a row, all answered, longest gap 509 ms, slowest answer 7 ms, shortest send gap 503 ms",
			],
		],
		findings: [],
		commands: NINE,
	},
];

for (const session of SESSIONS) {
	const path = join(import.meta.dir, "fixtures", session.file);

	test(`${session.name}: the fixture is the downloaded transcript byte for byte, it parses whole, and its verdict ${session.verdict}`, async () => {
		const bytes = readFileSync(path);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(session.sha256);
		const raw: unknown = JSON.parse(bytes.toString("utf8"));
		const transcript = parseTranscript(raw);
		expect(raw).toStrictEqual(transcript);
		const verdict = await evaluateU1(transcript, { expected: U1_EXPECTED, typing: "types" });
		expect(verdict.frames).toEqual({ title: "Every frame sent is one of the nine golden frames", pass: true, detail: `all ${session.golden} out entries are golden` });
		expect(verdict.checks.map((check) => [check.id, check.pass, check.detail])).toEqual(session.checks);
		expect(verdict.findings).toEqual(session.findings);
		expect(verdict.commands).toEqual(session.commands);
	});

	test(`${session.name}: the verdict CLI takes the transcript as evidence, writes its fixture, and exits 1 because a check fails`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "u1-hardware-"));
		const log = spyOn(console, "log").mockImplementation(() => undefined);
		try {
			const out = join(dir, "u1-macos.json");
			expect(await verdictMain([path, "--types", "--out", out])).toBe(1);
			expect(existsSync(out)).toBe(true);
			const fixture = JSON.parse(readFileSync(out, "utf8"));
			expect(fixture.checks.map((check: { id: number; pass: boolean; detail: string }) => [check.id, check.pass, check.detail])).toEqual(session.checks);
			expect(fixture.frames.pass).toBe(true);
		} finally {
			log.mockRestore();
			rmSync(dir, { recursive: true, force: true });
		}
	});
}
