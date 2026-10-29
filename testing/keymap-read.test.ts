import { expect, test } from "bun:test";
import { createKit } from "../core/kit";
import { FACTORY_LAYER2, type OsKeyMode, TAB60_KEYS, keyId } from "../core/keymap";
import { SHIPPED } from "../core/protocol";
import { TARGET } from "./fake-run";
import { FakeTab60, type FakeOptions } from "./fake-tab60";

function fake(options: Partial<FakeOptions> = {}): FakeTab60 {
	return new FakeTab60({ starting: "official-image", target: TARGET, clock: "virtual", reenumerateAfterMs: 0, ...options });
}

const pairs = (board: FakeTab60, from = 0) => board.received.slice(from).map(({ cmd, sub }) => ((cmd << 8) | sub).toString(16).padStart(4, "0"));

async function read(board: FakeTab60, mode: OsKeyMode = "windows") {
	const kit = createKit(board.port(), SHIPPED);
	const from = board.received.length;
	const end = await kit.readKeymap(mode);
	return { end, sent: pairs(board, from) };
}

test("Read keymap sends only Apply's reads, no gate and no write, and returns the store with the factory layer 2", async () => {
	const board = fake();
	const { end, sent } = await read(board);
	expect(sent).toEqual(["1202", "1200", ...Array<string>(16).fill("5221"), ...Array<string>(118).fill("5220")]);
	if (end.kind !== "finished" || end.result.kind !== "keymap-read") throw new Error(`not read: ${JSON.stringify(end)}`);
	const layer2 = end.result.store.get(2)!;
	const factory = [...layer2.values()].filter((entry) => entry.kind === "override" && entry.flags === 1);
	expect(factory).toHaveLength(FACTORY_LAYER2.length);
	expect([...end.result.store.get(1)!.values()].every((entry) => entry.kind !== "override")).toBe(true);
	expect(end).toMatchObject({ at: "app" });
});

test("an override on the board shows in the read at its cap, under the mode it was read in", async () => {
	const caps = TAB60_KEYS.find((cap) => cap.legend === "Caps")!;
	const board = fake({ overrides: [{ layer: 1, cell: caps.id, usage: 0x29, flags: 0 }] });
	const { end } = await read(board);
	if (end.kind !== "finished" || end.result.kind !== "keymap-read") throw new Error(`not read: ${JSON.stringify(end)}`);
	expect(end.result.store.get(1)!.get(keyId(caps.id))).toEqual({ kind: "override", code: 0x29, flags: 0 });
});

test("a board in another OS key mode stops after layer 0, as Apply does, and reads no key", async () => {
	const board = fake({ osKeyMode: 0x20 });
	const { end, sent } = await read(board, "windows");
	expect(end).toMatchObject({ kind: "stopped", reason: { kind: "keymap", problem: { kind: "mode-disagrees", mode: "windows" } } });
	expect(sent).not.toContain("5220");
});
