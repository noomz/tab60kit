import { copyFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** Every page the build writes. web/csp.test.ts checks each one's policy. */
export const PAGES = [
	{ html: "web/index.html", entry: "web/main.ts", outdir: "dist" },
	{ html: "lab/u1.html", entry: "lab/u1.ts", outdir: "dist-lab" },
] as const;

const repo = join(import.meta.dir, "..");

function git(args: readonly string[]): string | null {
	const result = Bun.spawnSync(["git", ...args], { cwd: repo });
	return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

/** The commit a page records in its transcripts, with a dirty flag so a transcript cannot claim a clean build it did not have. */
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
		console.log(`built ${page.outdir}/${basename(page.html)} from ${commit}`);
	}
}

if (import.meta.main) await build(resolve(process.argv[2] ?? repo));
