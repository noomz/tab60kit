/**
 * The page's ?fake modes. Each sets up the fake board and the fake WebHID for one recovery path, and flips them when a
 * run starts. DOM-free, so testing/u1-fake-modes.test.ts drives every mode through the page's own run logic.
 */
import type { Mode } from "../core/units";
import { type FakeOptions, FakeTab60 } from "../testing/fake-tab60";
import { FakeHid, type FakeHidOptions, FakeLocks } from "../testing/fake-webhid";
import { U1_EXPECTED } from "./u1-job";
import type { Run } from "./u1-state";

export const FAKE_MODES = ["plain", "parked", "deaf", "cancelled", "refused", "sum-refused", "drop", "slow"] as const;
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
	/** What the mode flips on the fakes when a run starts. */
	readonly adjust?: (what: Run, fakes: Fakes) => void;
}

const recovers = (what: Run) => what === "try-again" || what === "restart";

const MODES: Readonly<Record<FakeMode, ModeSpec>> = {
	plain: {},
	/** Only the update-mode chooser misses its row, the R3 C7 fallback that the parked pick exists for. */
	parked: { rows: ["app"] },
	deaf: {
		setup: ({ board }) => {
			board.ignoreInIap = true;
		},
		adjust: (what, { board }) => {
			if (recovers(what)) board.ignoreInIap = false;
		},
	},
	/** From the Deep check click until Try again or Restart, every chooser closes with no device. */
	cancelled: {
		adjust: (what, { hid }) => {
			if (what === "deep-check") hid.chooser = "cancel";
			if (recovers(what)) hid.chooser = "pick";
		},
	},
	/** FW INFO disagrees with BL info, so the update-mode attach refuses and the page holds the refusal. */
	refused: { board: () => ({ fwInfo: 0x400 }) },
	"sum-refused": { board: () => ({ refuseOnce: { cmd: 0x1d, sub: 0x01 } }) },
	/** After one Connect: its 5 frames and probes, RESET to IAP, attach and observe's 7, then four probes. */
	drop: { board: (probes) => ({ loseLinkAtPacket: 5 + probes + 1 + 7 + 4 }) },
	/** The fifth update-mode probe (attach's READ MODE comes first) answers after 700 ms, inside READ MODE's 1 s. */
	slow: { board: () => ({ slowOnce: { cmd: 0x12, sub: 0x02, mode: "iap", ms: 700, skip: 5 } }) },
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
