import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PAGES, build, toolCommit } from "../scripts/build";

const out = mkdtempSync(join(tmpdir(), "tab60kit-build-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
await build(out);

async function parse(html: string) {
	let order = 0;
	const policies: { readonly content: string; readonly order: number }[] = [];
	const scripts: { readonly src: string | null; readonly order: number; text: string }[] = [];
	const inline: string[] = [];
	await new HTMLRewriter()
		.on("*", {
			element(element) {
				order++;
				if (element.tagName === "style") inline.push("a <style> element");
				for (const [name] of element.attributes) {
					if (name === "style" || name.startsWith("on")) inline.push(`<${element.tagName} ${name}>`);
				}
			},
		})
		.on("head > meta[http-equiv]", {
			element(element) {
				if (element.getAttribute("http-equiv")?.toLowerCase() !== "content-security-policy") return;
				policies.push({ content: element.getAttribute("content") ?? "", order });
			},
		})
		.on("script", {
			element(element) {
				scripts.push({ src: element.getAttribute("src"), order, text: "" });
			},
			text(chunk) {
				scripts[scripts.length - 1]!.text += chunk.text;
			},
		})
		.transform(new Response(html))
		.text();
	return { policies, scripts, inline };
}

const directives = (policy: string) =>
	Object.fromEntries(
		policy
			.split(";")
			.map((directive) => directive.trim().split(/\s+/))
			.filter((words) => words[0] !== "")
			.map(([name = "", ...sources]) => [name.toLowerCase(), sources]),
	);

for (const { html, outdir } of PAGES) {
	const dist = join(out, outdir);
	const built = join(dist, basename(html));
	const page = await parse(readFileSync(built, "utf8"));

	describe(`${outdir}/${basename(html)}`, () => {
		test("has one CSP in <head> with exactly the reviewed directives", () => {
			expect(page.policies).toHaveLength(1);
			expect(directives(page.policies[0]!.content)).toEqual({
				"default-src": ["'self'"],
				"connect-src": ["'none'"],
				"script-src": ["'self'"],
				"object-src": ["'none'"],
				"base-uri": ["'none'"],
			});
		});

		test("every script has a src that the build wrote, no inline body, and comes after the CSP", () => {
			expect(page.scripts.length).toBeGreaterThan(0);
			for (const script of page.scripts) {
				expect(script.src).not.toBeNull();
				expect(existsSync(join(dist, script.src!))).toBe(true);
				expect(script.text.trim()).toBe("");
				expect(script.order).toBeGreaterThan(page.policies[0]!.order);
			}
		});

		test("has no inline style or inline event handler", () => {
			expect(page.inline).toEqual([]);
		});
	});
}

test("the lab page carries the commit it was built from", () => {
	const bundle = readFileSync(join(out, "dist-lab", "u1.js"), "utf8");
	expect(bundle).not.toContain("TAB60KIT_COMMIT");
	expect(bundle).toContain(JSON.stringify(toolCommit()));
});
