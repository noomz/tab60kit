// Import and egress rules the compiler cannot see. Each rule prints PASS or FAIL; the exit code counts failures.
// Run: bun probes/boundaries.ts [repo root]   (probes/run.sh runs it on this tree and on mutated copies)
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
const SKIP = new Set(["node_modules", "probes"]);
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; exports: Record<string, string> };

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return SKIP.has(name) ? [] : sources(path);
		return name.endsWith(".ts") ? [path] : [];
	});
}

interface Import {
	readonly specifier: string;
	readonly target: string;
}

/**
 * Relative imports and re-exports of one file, and imports of this package's exported entries, resolved to paths
 * under the root. Other imports are skipped, and tsc already rejects a subpath the package does not export.
 */
function importsOf(file: string): Import[] {
	const text = readFileSync(file, "utf8");
	const found: Import[] = [];
	for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s+[^'";]*?\s*from\s*["']([^"']+)["']/g)) {
		const [, specifier = ""] = match;
		if (specifier.startsWith(".")) {
			found.push({ specifier, target: resolve(dirname(file), specifier.endsWith(".ts") ? specifier : `${specifier}.ts`) });
		} else if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) {
			const entry = pkg.exports[`.${specifier.slice(pkg.name.length)}`];
			if (entry !== undefined) found.push({ specifier, target: resolve(root, entry) });
		}
	}
	return found;
}

const at = (path: string) => relative(root, path);
const files = sources(root);
let failures = 0;
const report = (rule: string, problems: readonly string[], ok: string) => {
	if (problems.length === 0) {
		console.log(`PASS ${rule}: ${ok}`);
		return;
	}
	failures++;
	console.log(`FAIL ${rule}: ${problems.join("; ")}`);
};

// Candidate B's rule: the fake board implements R1 and R4 from the documents with its own byte handling. Its import
// closure may enter core/ only through the seam it implements, so a host codec bug cannot cancel out in the fake.
{
	const start = join(root, "testing/fake-tab60.ts");
	const allowed = new Set(["core/port.ts", "core/units.ts"]);
	const problems: string[] = [];
	const seen = new Set<string>();
	const queue: { readonly file: string; readonly chain: string }[] = [{ file: start, chain: at(start) }];
	while (queue.length > 0) {
		const { file, chain } = queue.shift()!;
		if (seen.has(file) || !existsSync(file)) continue;
		seen.add(file);
		for (const { target } of importsOf(file)) {
			const name = at(target);
			if (name.startsWith("core/")) {
				if (!allowed.has(name)) problems.push(`${chain} -> ${name}`);
			} else queue.push({ file: target, chain: `${chain} -> ${name}` });
		}
	}
	report("fake-board-independence", problems, "testing/fake-tab60.ts reaches core/ only through port.ts and units.ts");
}

// The package exports "." (core/index.ts) and "./port" (core/port.ts). A relative path reaches any file, so web/
// names the core only by package: UI files import @tab60kit/core, the WebHID shell may add @tab60kit/core/port, and
// relative imports stay inside web/. Nothing in web/ then reaches lab/, testing/, tools/, or a core internal.
{
	const shell = "web/webhid-port.ts";
	const problems: string[] = [];
	for (const file of files.filter((path) => at(path).startsWith("web/"))) {
		for (const { specifier, target } of importsOf(file)) {
			const allowed = specifier.startsWith(".")
				? at(target).startsWith("web/")
				: specifier === "@tab60kit/core" || (specifier === "@tab60kit/core/port" && at(file) === shell);
			if (!allowed) problems.push(`${at(file)} imports ${specifier}`);
		}
	}
	report("web-entries", problems, "web/ imports @tab60kit/core, only the WebHID shell adds @tab60kit/core/port, and relative imports stay in web/");
}

// One egress: the audit makes the only OutReport, and the WebHID link makes the only sendReport call.
{
	const problems: string[] = [];
	const casts = files.flatMap((file) =>
		[...readFileSync(file, "utf8").matchAll(/\bas\s+OutReport\b|<OutReport>/g)].map(() => at(file)),
	);
	if (casts.length !== 1 || casts[0] !== "core/protocol.ts") problems.push(`casts to OutReport in ${casts.join(", ") || "no file"}, want one in core/protocol.ts`);
	for (const file of files) {
		if (at(file) !== "web/webhid-port.ts" && /\.send(?:Feature)?Report\s*\(/.test(readFileSync(file, "utf8"))) {
			problems.push(`${at(file)} calls sendReport`);
		}
	}
	report("one-egress", problems, "one cast to OutReport (core/protocol.ts auditEgress); sendReport only in web/webhid-port.ts");
}

// The lab port: startWebHidLab hands the DevicePort itself out, so only lab pages may name it. The shipped page
// reaches the board through startWebHid alone, which returns a kit and a chooser.
{
	const allowed = (file: string) => file.startsWith("lab/") || file === "web/webhid-port.ts" || file.endsWith(".test.ts");
	const problems = files.filter((file) => !allowed(at(file)) && /\bstartWebHidLab\b/.test(readFileSync(file, "utf8"))).map(at);
	report("lab-port", problems.map((file) => `${file} references startWebHidLab`), "only lab/ and the WebHID shell reference startWebHidLab");
}

process.exit(failures);
