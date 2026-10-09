import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A variable specifier keeps tsc from resolving it. probes/internal-modules-unreachable.ts is the type-level check.
const load = (specifier: string) => import(specifier);

test("@tab60kit/core and @tab60kit/core/port load", async () => {
	expect(await load("@tab60kit/core")).toHaveProperty("createKit");
	expect(await load("@tab60kit/core/port")).toHaveProperty("asInReport");
});

test("importing @tab60kit/core/protocol fails to resolve", async () => {
	await expect(load("@tab60kit/core/protocol")).rejects.toThrow("Cannot find module '@tab60kit/core/protocol'");
});

test('package.json exports "." and "./port" only', () => {
	const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8"));
	expect(pkg.exports).toEqual({ ".": "./core/index.ts", "./port": "./core/port.ts" });
});
