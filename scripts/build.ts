import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const sans = "node_modules/@fontsource/ibm-plex-sans";
const mono = "node_modules/@fontsource/ibm-plex-mono";

/** The shipped page's stylesheet and its self-hosted IBM Plex fonts, with each font's SIL OFL 1.1 text. Output path, then source. */
const WEB_ASSETS: readonly (readonly [string, string])[] = [
	["app.css", "web/app.css"],
	...(["400", "500", "600"] as const).map((weight): [string, string] => [`fonts/ibm-plex-sans-latin-${weight}-normal.woff2`, `${sans}/files/ibm-plex-sans-latin-${weight}-normal.woff2`]),
	...(["400", "600"] as const).map((weight): [string, string] => [`fonts/ibm-plex-mono-latin-${weight}-normal.woff2`, `${mono}/files/ibm-plex-mono-latin-${weight}-normal.woff2`]),
	["fonts/IBM-Plex-Sans-OFL.txt", `${sans}/LICENSE`],
	["fonts/IBM-Plex-Mono-OFL.txt", `${mono}/LICENSE`],
];

export const PAGES = [
	{ html: "web/index.html", entry: "web/main.ts", outdir: "dist", assets: WEB_ASSETS },
	{ html: "lab/u1.html", entry: "lab/u1.ts", outdir: "dist-lab" },
	{ html: "lab/u6.html", entry: "lab/u6.ts", outdir: "dist-lab-u6" },
	{ html: "lab/u10.html", entry: "lab/u10.ts", outdir: "dist-lab-u10" },
	{ html: "lab/u11.html", entry: "lab/u11.ts", outdir: "dist-lab-u11" },
	{ html: "lab/u12.html", entry: "lab/u12.ts", outdir: "dist-lab-u12" },
	{ html: "lab/u7.html", entry: "lab/u7.ts", outdir: "dist-lab-u7" },
] as const;

const repo = join(import.meta.dir, "..");

function git(args: readonly string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd: repo });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

export function toolCommit(): string {
	const sha = git(["rev-parse", "--short", "HEAD"]) ?? "unknown";
	const dirty = (git(["status", "--porcelain"]) ?? "") !== "";
	return dirty ? `${sha}-dirty` : sha;
}

export async function build(outRoot: string): Promise<void> {
	const commit = toolCommit();
	for (const page of PAGES) {
		const outdir = join(outRoot, page.outdir);
		rmSync(outdir, { recursive: true, force: true });
		const result = await Bun.build({
			entrypoints: [join(repo, page.entry)],
			outdir,
			naming: "[name].js",
			target: "browser",
			format: "esm",
			minify: false,
			define: { TAB60KIT_COMMIT: JSON.stringify(commit) },
		});
		if (!result.success) throw new AggregateError(result.logs, `${page.entry} did not build`);
		copyFileSync(join(repo, page.html), join(outdir, basename(page.html)));
		for (const [to, from] of "assets" in page ? page.assets : []) {
			mkdirSync(dirname(join(outdir, to)), { recursive: true });
			copyFileSync(join(repo, from), join(outdir, to));
		}
		console.log(`built ${page.outdir}/${basename(page.html)} from ${commit}`);
	}
}

if (import.meta.main) await build(resolve(process.argv[2] ?? repo));
