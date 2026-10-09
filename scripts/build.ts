// Bundles each page for the browser: its entry module to <outdir>/<entry name>.js beside a copy of its HTML.
// Run: bun scripts/build.ts [output root]   (default: the repo root, so the page lands in dist/)
import { copyFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const PAGES = [{ html: "web/index.html", entry: "web/main.ts", outdir: "dist" }] as const;

const repo = join(import.meta.dir, "..");
const outRoot = resolve(process.argv[2] ?? repo);

for (const page of PAGES) {
	const outdir = join(outRoot, page.outdir);
	rmSync(outdir, { recursive: true, force: true });
	await Bun.build({
		entrypoints: [join(repo, page.entry)],
		outdir,
		naming: "[name].js",
		target: "browser",
		format: "esm",
		minify: false,
	});
	copyFileSync(join(repo, page.html), join(outdir, "index.html"));
	console.log(`built ${page.outdir}/`);
}
