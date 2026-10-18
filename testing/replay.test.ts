import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { U1_PROBES, type U1Context, u1Clearance, u1Connect, u1DeepCheck } from "../lab/u1-job";
import { parseTranscript, replayPort } from "./transcript";

const fixture = (name: string) => parseTranscript(JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8")));

/** What the U1 lab page ran: Connect, then Deep check, which comes home through the confirm pick. */
async function replayU1(name: string) {
	const port = replayPort(fixture(name));
	const ctx: U1Context = { port, clearance: u1Clearance(), signal: new AbortController().signal, log: () => undefined, series: U1_PROBES };
	const connected = await u1Connect(ctx);
	if (connected.kind !== "connected") throw new Error(`normal mode refused: ${connected.refused.refusal.code}`);
	return { port, end: await u1DeepCheck(connected.session, ctx) };
}

for (const name of ["tab60kit-u1-2026-10-12T09-02-24-367Z.json", "tab60kit-u1-2026-10-12T09-07-15-464Z.json"]) {
	test(`the U1 transcript ${name} replays through today's core with no divergence`, async () => {
		const { port, end } = await replayU1(name);
		expect(port.divergence).toBeNull();
		expect(port.remaining()).toEqual([]);
		expect(end).toMatchObject({ kind: "done", bootTarget: "normal-mode", back: { mode: "app" } });
	});
}

test("the first U1 transcript, recorded before attach read the version page in update mode, diverges where the core changed", async () => {
	await expect(replayU1("tab60kit-u1-2026-10-10T12-16-20-942Z.json")).rejects.toThrow("replay diverged at entry 99");
});

test("replay refuses a frame the transcript did not record, and an open for the wrong mode or reason", async () => {
	const transcript = fixture("tab60kit-u1-2026-10-12T09-07-15-464Z.json");
	const port = replayPort(transcript);
	const signal = new AbortController().signal;
	const link = await port.open({ modes: ["app"], reason: "connect" }, signal);
	const frame = new Uint8Array(64);
	frame[0] = 0x12;
	frame[1] = 0x00;
	await expect(link.send(frame as never)).rejects.toThrow("replay diverged at entry 9: the transcript has out 120200");
	expect(port.divergence?.index).toBe(9);

	const wrongMode = replayPort(transcript);
	await expect(wrongMode.open({ modes: ["iap"], reason: "connect" }, signal)).rejects.toThrow("an open for iap");

	const wrongReason = replayPort(transcript);
	await expect(wrongReason.open({ modes: ["app"], reason: "after-link-loss" }, signal)).rejects.toThrow("an open for after-link-loss");
	expect(wrongReason.divergence?.index).toBe(8);
});

test("replay rejects a pending open when its signal aborts", async () => {
	const port = replayPort(fixture("tab60kit-u1-2026-10-12T09-07-15-464Z.json"));
	const link = await port.open({ modes: ["app"], reason: "connect" }, new AbortController().signal);
	void link;
	const cancel = new AbortController();
	const pending = port.open({ modes: ["iap"], reason: "enter-update-mode" }, cancel.signal);
	cancel.abort(new Error("cancelled"));
	await expect(pending).rejects.toThrow("cancelled");
});
