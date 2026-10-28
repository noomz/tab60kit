/** DOM-free, so testing/u1-fake-modes.test.ts drives every mode through the page's own run logic. */
import type { Mode } from "../core/units";
import { type FakeOptions, FakeTab60, blInfoBlock } from "../testing/fake-tab60";
import { FakeHid, type FakeHidOptions, FakeLocks } from "../testing/fake-webhid";
import { U1_EXPECTED } from "./u1-job";
import type { Run } from "./u1-state";

export const FAKE_MODES = ["plain", "parked", "deaf", "cancelled", "refused", "sum-refused", "drop", "slow", "reloaded"] as const;
export type FakeMode = (typeof FAKE_MODES)[number];
export const isFakeMode = (value: string): value is FakeMode => FAKE_MODES.some((mode) => mode === value);

interface Fakes {
	readonly board: FakeTab60;
	readonly hid: FakeHid;
}

interface ModeSpec {
	readonly board?: (probes: number) => Partial<FakeOptions>;
	readonly rows?: readonly Mode[];
	readonly setup?: (fakes: Fakes) => void;
	readonly adjust?: (what: Run, fakes: Fakes) => void;
}

const recovers = (what: Run) => what === "try-again" || what === "restart";

const READ_MODE = { cmd: 0x12, sub: 0x02 } as const;
const SUM = { cmd: 0x1d, sub: 0x01 } as const;
/** Past the page's 500 ms spacing and inside READ MODE's 1 s timeout, so check 9 judges the answer instead of a timeout. */
const SLOW_ANSWER_MS = 700;
const ATTACH_READ_MODES = 1;
const PROBE_TO_SLOW = 5;
const PROBE_TO_DROP = 5;

/** Output reports from page load, with one Connect first, up to the nth update-mode probe. */
function packetsBeforeUpdateProbe(probes: number, nth: number): number {
	const connect = { attach: 2, versionPage: 3, probes };
	const update = { reset: 1, attach: 3, versionPage: 3, sum: 1 };
	return connect.attach + connect.versionPage + connect.probes + update.reset + update.attach + update.versionPage + update.sum + (nth - 1);
}

const MODES: Readonly<Record<FakeMode, ModeSpec>> = {
	plain: {},
	/** Only the update-mode chooser misses its row, the docs/webhid.md C7 fallback that the parked pick exists for. */
	parked: { rows: ["app"] },
	deaf: {
		setup: ({ board }) => {
			board.ignoreInIap = true;
		},
		adjust: (what, { board }) => {
			if (recovers(what)) board.ignoreInIap = false;
		},
	},
	cancelled: {
		adjust: (what, { hid }) => {
			if (what === "deep-check") hid.chooser = "cancel";
			if (recovers(what)) hid.chooser = "pick";
		},
	},
	refused: { board: () => ({ blInfoInIap: blInfoBlock({ fwPages: U1_EXPECTED.fwPages + 1 }) }) },
	"sum-refused": { board: () => ({ refuseOnce: SUM }) },
	drop: { board: (probes) => ({ loseLinkAtPacket: packetsBeforeUpdateProbe(probes, PROBE_TO_DROP) }) },
	slow: { board: () => ({ slowOnce: { ...READ_MODE, mode: "iap", ms: SLOW_ANSWER_MS, skip: ATTACH_READ_MODES + PROBE_TO_SLOW - 1 } }) },
	/** A reload after an earlier page left the board in update mode, with the bootloader still granted. */
	reloaded: {
		board: () => ({ starting: "update-mode-official-image" }),
		setup: ({ hid }) => hid.grant(),
	},
};

export interface FakeHardware extends Fakes {
	readonly locks: FakeLocks;
	readonly adjust: (what: Run) => void;
}

export function fakeHardware(mode: FakeMode, options: { readonly probes: number; readonly hid?: Partial<FakeHidOptions> }): FakeHardware {
	const spec = MODES[mode];
	const board = new FakeTab60({
		starting: "official-image",
		target: { imageBytes: U1_EXPECTED.imageBytes, wireSum32: U1_EXPECTED.imageSum32 },
		...spec.board?.(options.probes),
	});
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: spec.rows ?? ["app", "iap"], ...options.hid });
	const fakes: Fakes = { board, hid };
	spec.setup?.(fakes);
	return { ...fakes, locks: new FakeLocks(), adjust: (what) => spec.adjust?.(what, fakes) };
}
