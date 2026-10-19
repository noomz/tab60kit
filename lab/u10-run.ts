/**
 * Plan U10's hardware read, DOM-free so testing/u10.test.ts runs it against the fake board. One Connect in normal mode,
 * layer 0 of the override store in 16 frames, then layers 1 and 2 one entry at a time for each usage present in the
 * active keymap of the board's OS key mode. Each entry is compared with `predictLayers` for that mode.
 */
import { type Layer, type OsKeyMode, predictLayers, presentUsages, usage } from "../core/keymap";
import type { DevicePort } from "../core/port";
import { type Clearance, type CommandName, type OverrideEntry, connect, labClearance } from "../core/protocol";
import type { TranscriptEntry } from "../testing/transcript";
import { preconditionsFor } from "./u1-state";

export const U10_PURPOSE = "U10: read the key override store";
/** The two reviewed reads, and the confirmed U1 rows a normal-mode attach sends. */
export const U10_ROWS = ["readMode", "readBlInfo", "cfgReadKeys", "cfgReadKey"] as const satisfies readonly CommandName[];
/** (cmd, sub) of each U10 row, written out so the frame check owes nothing to the registry. */
const U10_PAIRS: readonly string[] = ["1202", "1200", "5221", "5220"];

export const u10Clearance = (): Clearance => labClearance(U10_ROWS, U10_PURPOSE);

/**
 * What the capture must attest before Read. The battery pull clears SRAM, so the board reads its saved block back;
 * another app holding the keyboard could send its own frames between ours.
 */
export const U10_PRECONDITIONS = [
	{ key: "batteryPulled", label: "The batteries were removed and USB unplugged for 10 s, then the board was reconnected over USB" },
	{ key: "keyboardFree", label: "No other app holds the keyboard" },
] as const;

export const u10Preconditions = preconditionsFor(U10_PRECONDITIONS);

export interface StoreRead {
	readonly entries: readonly { readonly layer: Layer; readonly usage: number; readonly entry: OverrideEntry }[];
}

/** Reads layer 0 whole and layers 1 and 2 at the usages present in `mode`, then closes the session. */
export async function readStore(port: DevicePort, clearance: Clearance, mode: OsKeyMode, signal: AbortSignal): Promise<StoreRead> {
	const session = await connect({ port, clearance, signal }, { modes: ["app"], reason: "connect" });
	try {
		if ("refusal" in session) throw new Error(`attach refused: ${session.refusal.code}`);
		const entries: StoreRead["entries"][number][] = [];
		for (const [k, entry] of await session.config.readLayer0(signal)) entries.push({ layer: 0, usage: k, entry });
		for (const layer of [1, 2] as const) {
			for (const k of presentUsages(mode)) entries.push({ layer, usage: k, entry: await session.config.readKey(layer, usage(k), signal) });
		}
		return { entries };
	} finally {
		await session.close();
	}
}

export function describeEntry(entry: OverrideEntry | undefined): string {
	if (entry === undefined) return "nothing";
	if (entry.kind !== "override") return entry.kind;
	return `override 0x${entry.code.toString(16).padStart(2, "0")} flags ${entry.flags}`;
}

const sameEntry = (a: OverrideEntry | undefined, b: OverrideEntry | undefined) => describeEntry(a) === describeEntry(b);
const hex = (n: number) => `0x${n.toString(16).padStart(2, "0")}`;

/** One line per entry that differs from `predictLayers(mode)`, in read order. */
export function diffAgainstPrediction(read: StoreRead, mode: OsKeyMode): readonly string[] {
	const predicted = predictLayers(mode);
	return read.entries.flatMap(({ layer, usage: k, entry }) => {
		const want = predicted.get(layer)?.get(k);
		return sameEntry(entry, want) ? [] : [`layer ${layer} usage ${hex(k)}: predicted ${describeEntry(want)}, read ${describeEntry(entry)}`];
	});
}

/** Each sent frame whose (cmd, sub) is not one of the U10 rows. The transcript is the capture only when this is empty. */
export function framesOutsideU10(entries: readonly TranscriptEntry[]): readonly string[] {
	return entries.flatMap((entry) => (entry.kind === "out" && !U10_PAIRS.includes(entry.hex.slice(0, 4)) ? [entry.hex] : []));
}
