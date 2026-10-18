/**
 * Plan U6's verdict on two hardware transcripts of the shipped page's checks: Connect, then Deep check. Like
 * u1-checks.ts it never borrows the host codec: frames are U1's written-out literals, and replies are read by offset.
 */
import { CATALOG, type CatalogEntry } from "../core/firmware";
import { type Transcript, type WireEntry, hexOf, isWire } from "../testing/transcript";
import { U1_FRAMES } from "./u1-frames";

export interface U6Check {
	readonly title: string;
	readonly pass: boolean;
	readonly detail: string;
}

const frame = (prefix: string): string => {
	const found = U1_FRAMES.find((hex) => hex.startsWith(prefix));
	if (found === undefined) throw new Error(`no U1 frame starts ${prefix}`);
	return found;
};

const READ_MODE = frame("1202");
const BL_INFO = frame("1200");
const FW_INFO = frame("1201");
const PAGE = [frame("1220"), frame("1221"), frame("1222")] as const;
const SUM = frame("1d01");

/** Connect (a quick check), then Deep check on the same session, then the confirm pick's attach. */
export const U6_SEQUENCE: readonly string[] = [
	READ_MODE, BL_INFO, ...PAGE,
	...PAGE, frame("1100"),
	READ_MODE, BL_INFO, FW_INFO, ...PAGE, SUM, frame("1101"),
	READ_MODE, BL_INFO,
];

const CLEAN_COMMIT = /^[0-9a-f]{7,40}$/;
const PAYLOAD_OFFSET = 4;
const PART_BYTES = 60;
const BLOCK_BYTES = 180;

const V1_01_13: CatalogEntry = (() => {
	const entry = CATALOG.find((candidate) => candidate.version === "V1.01.13");
	if (entry === undefined) throw new Error("the catalog lost V1.01.13");
	return entry;
})();

const wire = (transcript: Transcript): readonly WireEntry[] => transcript.entries.filter(isWire);

/** One wire entry with its time left out. */
function untimed(entry: WireEntry): string {
	switch (entry.kind) {
		case "opened":
			return `opened 0x${entry.productId.toString(16)} for ${entry.reason}`;
		case "out":
		case "in":
			return `${entry.kind} ${entry.hex}`;
		case "out-write":
			return `out-write ${entry.header} ${entry.payloadBytes} ${entry.payloadSha256}`;
		case "send-failed":
			return `send-failed ${entry.hex} ${entry.error}`;
		case "lost":
		case "closed":
			return `${entry.kind}${entry.mode === undefined ? "" : ` ${entry.mode}`}`;
		default: {
			const exhaustive: never = entry;
			return exhaustive;
		}
	}
}

const bytesOf = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** Each request's reply: the `in` entry that follows its `out`, or null when another frame came first. */
function exchanges(transcript: Transcript): readonly { readonly out: string; readonly reply: Uint8Array | null }[] {
	const entries = wire(transcript);
	return entries.flatMap((entry, at) => {
		if (entry.kind !== "out") return [];
		const next = entries.slice(at + 1).find((later) => later.kind === "in" || later.kind === "out");
		return [{ out: entry.hex, reply: next?.kind === "in" ? bytesOf(next.hex) : null }];
	});
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))));
}

function evidence(name: string, transcript: Transcript): string | null {
	const { fake, tool } = transcript.environment;
	if (fake !== "no") return `${name}: environment.fake is "${fake}", and a fake board is not evidence`;
	if (tool === undefined || !CLEAN_COMMIT.test(tool)) return `${name}: environment.tool is "${String(tool)}", and only a build from a clean commit is evidence`;
	return null;
}

export async function evaluateU6(first: Transcript, second: Transcript): Promise<readonly U6Check[]> {
	const pair = [
		["first", first],
		["second", second],
	] as const;
	const checks: U6Check[] = [];

	const notEvidence = pair.map(([name, t]) => evidence(name, t)).filter((why) => why !== null);
	checks.push({ title: "Both transcripts record the real board from a clean build", pass: notEvidence.length === 0, detail: notEvidence.join("; ") || "fake: no, clean tool commits" });

	const a = wire(first).map(untimed);
	const b = wire(second).map(untimed);
	const at = a.findIndex((line, i) => line !== b[i]);
	const differ = at !== -1 || a.length !== b.length;
	const where = at === -1 ? Math.min(a.length, b.length) : at;
	checks.push({
		title: "The two transcripts are identical apart from timing",
		pass: !differ,
		detail: differ ? `wire entry ${where}: "${a[where] ?? "nothing"}" against "${b[where] ?? "nothing"}"` : `${a.length} wire entries each`,
	});

	for (const [name, t] of pair) {
		const sent = wire(t).filter((entry) => entry.kind === "out").map((entry) => entry.hex);
		const off = sent.findIndex((hex, i) => hex !== U6_SEQUENCE[i]);
		const pass = off === -1 && sent.length === U6_SEQUENCE.length;
		const i = off === -1 ? Math.min(sent.length, U6_SEQUENCE.length) : off;
		checks.push({
			title: `${name}: Connect then Deep check sends U1's frames in order`,
			pass,
			detail: pass ? `${sent.length} frames` : `frame ${i}: sent ${sent[i]?.slice(0, 16) ?? "nothing"}, expected ${U6_SEQUENCE[i]?.slice(0, 16) ?? "nothing"}`,
		});
	}

	const pages: string[] = [];
	const sums: number[] = [];
	for (const [, t] of pair) {
		const done = exchanges(t);
		for (let i = 0; i + 2 < done.length; i++) {
			if (done[i]?.out !== PAGE[0] || done[i + 1]?.out !== PAGE[1] || done[i + 2]?.out !== PAGE[2]) continue;
			const block = new Uint8Array(BLOCK_BYTES);
			for (let part = 0; part < 3; part++) block.set(done[i + part]?.reply?.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + PART_BYTES) ?? new Uint8Array(PART_BYTES), part * PART_BYTES);
			pages.push(await sha256Hex(block));
		}
		for (const { out, reply } of done) {
			if (out === SUM && reply !== null) sums.push(new DataView(reply.buffer, reply.byteOffset).getUint32(PAYLOAD_OFFSET, true));
		}
	}
	const pagesOk = pages.length === 6 && pages.every((hash) => hash === V1_01_13.versionBlock.sha256);
	checks.push({
		title: "Every version page read, in both modes, hashes to the catalog's V1.01.13 block (official by its bytes)",
		pass: pagesOk,
		detail: pagesOk ? "6 reads" : `${pages.length} reads, hashes ${[...new Set(pages)].map((h) => h.slice(0, 12)).join(", ") || "none"}; expected ${V1_01_13.versionBlock.sha256.slice(0, 12)}`,
	});
	const sumsOk = sums.length === 2 && sums.every((sum) => sum === V1_01_13.image.wireSum32);
	checks.push({
		title: "SUM over the image answers the catalog's wire sum (official by its sum)",
		pass: sumsOk,
		detail: `${sums.map((s) => `0x${s.toString(16)}`).join(", ") || "no SUM reply"}; expected 0x${V1_01_13.image.wireSum32.toString(16)}`,
	});
	return checks;
}
