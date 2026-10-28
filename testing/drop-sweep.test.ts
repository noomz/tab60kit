import { expect, test } from "bun:test";
import { dropSweep, inShard, parseShard } from "./drop-sweep";
import { syntheticFlashable } from "./synthetic-image";

test("every sequence number belongs to exactly one shard, for several shard counts", () => {
	for (const count of [1, 2, 3, 4, 7]) {
		for (let sequence = 0; sequence < 200; sequence++) {
			const owners = Array.from({ length: count }, (_, index) => index).filter((index) => inShard(sequence, { index, count }));
			expect(owners).toHaveLength(1);
		}
	}
	expect(inShard(5, undefined)).toBe(true);
});

test("shard flags parse, and a bad one is refused", () => {
	expect(parseShard("2/4")).toEqual({ index: 2, count: 4 });
	for (const bad of ["4/4", "0/0", "1", "a/b", "-1/4", "1/4/5"]) expect(() => parseShard(bad)).toThrow("bad shard");
});

test("the shards of one sweep cell run exactly its whole run set between them, each a fair share", async () => {
	const image = await syntheticFlashable();
	const count = 3;
	const parts = [];
	for (let index = 0; index < count; index++) parts.push(await dropSweep(image, ["holds-target"], ["erases"], { index, count }));
	const total = parts[0]!.total;
	expect(total).toBeGreaterThan(1000);
	expect(parts.map((part) => part.total)).toEqual([total, total, total]);
	expect(parts.reduce((n, part) => n + part.runs, 0)).toBe(total);
	for (const part of parts) expect(Math.abs(part.runs - total / count)).toBeLessThan(1);
	expect(parts.flatMap((part) => part.failures)).toEqual([]);
}, 120_000);
