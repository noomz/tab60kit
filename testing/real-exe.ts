/**
 * Unit U3's check on the vendor's own exe: the TypeScript extractor against its oracle, tools/oracle/decode_updater.py.
 * The exe is never committed, so this runs locally, before every release. It fails when the exe is missing.
 *
 * Run: TAB60_EXE=<Tab60firmwareV1.01.13.exe> bun run real-exe. TAB60_DECODER overrides the oracle's path.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, admit, crc32, imageBytes, readUpdater, sha256, sum32, xorWords } from "../core/firmware";
import { type UpdaterContents, parseMaav102 } from "../core/updater";
import { refusalCases, withImageByteFlipped } from "./updater-cases";

const exePath = process.env.TAB60_EXE;
const decoder = process.env.TAB60_DECODER ?? new URL("../tools/oracle/decode_updater.py", import.meta.url).pathname;
if (!exePath) {
	console.error("FAIL TAB60_EXE (the V1.01.13 updater) must be set");
	process.exit(1);
}

let failures = 0;
function check(ok: boolean, label: string): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${label}`);
	if (!ok) failures++;
}
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const hex = (n: number, digits: number) => `0x${n.toString(16).padStart(digits, "0")}`;

const [entry] = CATALOG;
if (entry === undefined) throw new Error("the catalog is empty");
const exe = new Uint8Array(readFileSync(exePath));
check((await sha256(exe)) === entry.source.exeSha256, `the input is the ${entry.version} updater the catalog names`);

const out = mkdtempSync(join(tmpdir(), "tab60kit-real-exe-"));
try {
	const oracle = Bun.spawnSync(["python3", "-I", decoder, exePath, out]);
	check(oracle.exitCode === 0, `the oracle extracts the exe (exit ${oracle.exitCode})`);
	const contents = parseMaav102(exe);
	check(!("code" in contents), `parseMaav102 reads the exe${"code" in contents ? ` (refused: ${contents.code})` : ""}`);
	if (oracle.exitCode === 0 && !("code" in contents)) await compare(contents, out);
} finally {
	rmSync(out, { recursive: true, force: true });
}

async function compare(contents: UpdaterContents, dir: string): Promise<void> {
	const meta = JSON.parse(readFileSync(join(dir, `${contents.product}_${contents.version}.json`), "utf8"));
	const device = meta.package.device;
	check(contents.title === meta.package.title && contents.product === meta.package.product, "title and product equal the oracle's");
	check(contents.version === meta.package.version, `version ${contents.version} equals the oracle's`);
	check(contents.identityHex === device.identity_hex, "identity block equals the oracle's");
	check(hex(contents.bootPid, 4) === device.boot_pid && hex(contents.appPid, 4) === device.app_pid, "boot and app product IDs equal the oracle's");
	check(contents.writeBlockSize === device.write_block_size, "write block size equals the oracle's");
	check(contents.images.length === meta.layouts.length, `${contents.images.length} image(s), as the oracle finds`);

	for (const [i, image] of contents.images.entries()) {
		const layout = meta.layouts[i];
		const plain = xorWords(image.wire);
		check(image.slot === layout.slot && image.layoutName === layout.name, `slot ${image.slot}: name "${image.layoutName}" equals the oracle's`);
		check(hex(image.layoutId, 4) === layout.layout_id, `slot ${image.slot}: layout id equals the oracle's`);
		check(same(plain, readFileSync(join(dir, layout.firmware.file))), `slot ${image.slot}: plain image equals the oracle's file byte for byte`);
		check((await sha256(image.wire)) === layout.firmware.wire_sha256, `slot ${image.slot}: wire form hashes to the oracle's wire_sha256`);
		check(hex(sum32(image.wire), 8) === layout.firmware.wire_sum32, `slot ${image.slot}: wire sum equals the oracle's`);
		check(
			same(image.versionBlock, readFileSync(join(dir, layout.version_block.file))),
			`slot ${image.slot}: version block equals the oracle's file byte for byte`,
		);
		const base = image.impliedBase === null ? null : `0x${image.impliedBase.toString(16)}`;
		check(base === layout.firmware.cortex_m.implied_base, `slot ${image.slot}: implied base ${base} equals the oracle's`);
	}

	const [image] = contents.images;
	if (image === undefined || entry === undefined) return;
	check((await sha256(xorWords(image.wire))) === entry.image.sha256, "plain image hashes to b77f3fe9...5f3d");
	check((await sha256(image.versionBlock)) === entry.versionBlock.sha256, "version block hashes to ca529cf6...d345");
	check(sum32(image.wire) === 0xf3d3_dbd2, "wire form sums to 0xF3D3DBD2");
	check(crc32(image.wire) === 0xf1ac_b333, "wire form has CRC-32 0xF1ACB333");

	for (const { label, exe: mutated, refusal } of refusalCases(exe)) {
		const got = parseMaav102(mutated) as unknown as Record<string, unknown>;
		const ok = Object.entries(refusal).every(([key, value]) => got[key] === value);
		check(ok, `refuses ${label}: ${String(got.code)}${got.why === undefined ? "" : ` (${String(got.why)})`}`);
	}

	const reading = await readUpdater(exe);
	const admission = reading.kind === "read" ? reading.images[0]?.admission : undefined;
	check(admission?.kind === "admitted" && admission.image.entry === entry, `admit admits ${entry.version}`);
	if (admission?.kind === "admitted") {
		const held = imageBytes(admission.image);
		check(same(held.wire.bytes, image.wire) && same(held.versionBlock.bytes, image.versionBlock), "imageBytes returns its bytes for that handle");
		check(held.versionBlock.version === entry.version, `the version block reads "${held.versionBlock.version}"`);
		const foreign = admit({
			provenance: { kind: "foreign" },
			layoutName: image.layoutName,
			plainSha256: entry.image.sha256,
			impliedBase: image.impliedBase,
			wire: held.wire,
			versionBlock: held.versionBlock,
		});
		check(foreign.kind === "refused" && foreign.refusal.code === "foreign-image", "admit refuses a foreign candidate (foreign-image)");
	}
	const flipped = await readUpdater(withImageByteFlipped(exe));
	const refusedFlip = flipped.kind === "read" ? flipped.images[0]?.admission : undefined;
	check(
		refusedFlip?.kind === "refused" && refusedFlip.refusal.code === "not-in-catalog",
		"admit refuses the same image with one byte flipped (not-in-catalog)",
	);
}

console.log(`\n${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
