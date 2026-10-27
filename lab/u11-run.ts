/**
 * Unit U11's hardware run, DOM-free so testing/u11.test.ts runs it against the fake board. One guided sequence: query
 * and open the gate, write Caps Lock to Left Control on layer 0, read it back, have the user type it over USB and over
 * Bluetooth, restore it, close the gate, then write it again and have the user power-cycle the board with no save.
 * Each run of wire steps opens its own normal-mode session, so the user can unplug USB between them.
 */
import { type Layer, usage } from "../core/keymap";
import type { DevicePort } from "../core/port";
import { type AppSession, type Clearance, type CommandName, type GateState, type OverrideEntry, type OverrideValue, connect, labClearance } from "../core/protocol";
import type { TranscriptEntry } from "../testing/transcript";
import { preconditionsFor } from "./u1-state";
import { describeEntry } from "./u10-run";

export const U11_PURPOSE = "U11: write one key override in RAM and see a power cycle drop it";
/** The four reviewed U11 rows, the confirmed read-back, and the confirmed U1 rows a normal-mode attach sends. */
export const U11_ROWS = ["readMode", "readBlInfo", "cfgReadKey", "gateQuery", "gateOpen", "gateClose", "cfgWriteKey"] as const satisfies readonly CommandName[];
/** Bytes 0..1 of each frame the run may send, written out so the frame check owes nothing to the registry. */
export const U11_PAIRS: readonly string[] = ["1202", "1200", "5220", "41ff", "4180", "4100", "5120"];
/** Bytes 0..1 of the attach reads, which open every session and are not plan steps. */
export const ATTACH_PAIRS: readonly string[] = ["1202", "1200"];

export const u11Clearance = (): Clearance => labClearance(U11_ROWS, U11_PURPOSE);

export const U11_PRECONDITIONS = [
	{ key: "keyboardFree", label: "No other app holds the keyboard" },
	{ key: "osModeNotSwapped", label: "The board's OS key mode is Windows (Fn+Q) or Mac (Fn+W), not the Caps/Ctrl swap (Fn+E), so usage 0x39 is the physical Caps Lock" },
	{ key: "noHostRemap", label: "Neither macOS Modifier Keys nor Karabiner remaps Caps Lock or Left Control" },
	{
		key: "noSavingKeys",
		label:
			"During the run I will press only Caps Lock. Each of these saves the profile to flash and spoils the power-cycle phase: Pn+R (resets the whole current profile, all three layers), both Alt keys together (reset all layers; in Mac mode Alt and GUI swap, so both GUI keys too), Left GUI+Right Alt+Space, Fn+Right Alt held while the board powers on, Fn+Left Shift or Pn+Left Shift held 3 s (move Fn or Pn), Fn+Q, Fn+W, or Fn+E (OS key mode), Win lock, and the LED and layer function keys",
	},
	{ key: "bluetoothReady", label: "The batteries are in and the board is paired with this computer over Bluetooth" },
] as const;

export const u11Preconditions = preconditionsFor(U11_PRECONDITIONS);

const CAPS_LOCK = usage(0x39);
const BASE: Layer = 0;
const LEFT_CONTROL: OverrideValue = { kind: "override", code: 0xe0, flags: 0 };
const NO_OVERRIDE: OverrideValue = { kind: "default" };
const CLOSED: GateState = { gate: 0, timer: 0 };

type WireCall =
	| { readonly op: "query"; readonly expect: GateState }
	| { readonly op: "open" }
	| { readonly op: "close" }
	| { readonly op: "write"; readonly value: OverrideValue; readonly expect: OverrideEntry }
	| { readonly op: "read"; readonly expect: OverrideEntry };

/** A frame the run sends, with the 64-byte request and reply as hex prefixes the rest of which is zero. */
export type WireStep = { readonly kind: "wire"; readonly id: string; readonly label: string; readonly request: string; readonly reply: string } & WireCall;

/** A step the user does. `keylog` names the code the page must log and the one it must not, or null for no typing. */
export interface UserStep {
	readonly kind: "user";
	readonly id: string;
	readonly label: string;
	readonly question: string;
	readonly keylog: { readonly want: string; readonly not: string } | null;
}

export type U11Step = WireStep | UserStep;

const TYPES_CONTROL = { want: "ControlLeft", not: "CapsLock" } as const;
const TYPES_CAPS_LOCK = { want: "CapsLock", not: "ControlLeft" } as const;

/** The run, in order. The verdict holds the transcript to this list: every request, every reply, every attestation. */
export const U11_STEPS: readonly U11Step[] = [
	{ kind: "wire", id: "query-start", label: "Query the gate: it reads closed", op: "query", expect: CLOSED, request: "41ff0000", reply: "41000000" },
	{ kind: "wire", id: "open", label: "Open the gate with byte 0x80", op: "open", request: "41800000", reply: "41800000" },
	{ kind: "wire", id: "write-control", label: "Write Caps Lock (0x39) on layer 0 as Left Control (0x00E0)", op: "write", value: LEFT_CONTROL, expect: LEFT_CONTROL, request: "51203900e000", reply: "51203900e000" },
	{ kind: "wire", id: "read-control", label: "Read Caps Lock back: 0x00E0", op: "read", expect: LEFT_CONTROL, request: "52203900", reply: "52203900e000" },
	{
		kind: "user",
		id: "keylog-usb",
		label: "Over USB, press Caps Lock on the TAB 60 two or three times, and no other key.",
		question: "Did Caps Lock act as Left Control, with the keylog showing ControlLeft and no CapsLock?",
		keylog: TYPES_CONTROL,
	},
	{
		kind: "user",
		id: "keylog-bluetooth",
		label: "Unplug USB. Switch the board to Bluetooth; the batteries keep it running. Press Caps Lock two or three times, and no other key. Then plug USB back in.",
		question: "Over Bluetooth, did Caps Lock act as Left Control, with the keylog showing ControlLeft and no CapsLock?",
		keylog: TYPES_CONTROL,
	},
	{ kind: "wire", id: "restore", label: "Restore Caps Lock with 0x00FF", op: "write", value: NO_OVERRIDE, expect: { kind: "default" }, request: "51203900ff00", reply: "51203900ff00" },
	{ kind: "wire", id: "read-default", label: "Read Caps Lock back: 0x00FF", op: "read", expect: { kind: "default" }, request: "52203900", reply: "52203900ff00" },
	{ kind: "wire", id: "close", label: "Close the gate", op: "close", request: "41000000", reply: "41000000" },
	{ kind: "wire", id: "query-closed", label: "Query the gate: it reads closed", op: "query", expect: CLOSED, request: "41ff0000", reply: "41000000" },
	{ kind: "wire", id: "open-again", label: "Open the gate again", op: "open", request: "41800000", reply: "41800000" },
	{ kind: "wire", id: "write-again", label: "Write Caps Lock as Left Control again", op: "write", value: LEFT_CONTROL, expect: LEFT_CONTROL, request: "51203900e000", reply: "51203900e000" },
	{ kind: "wire", id: "read-again", label: "Read Caps Lock back: 0x00E0", op: "read", expect: LEFT_CONTROL, request: "52203900", reply: "52203900e000" },
	{
		kind: "user",
		id: "power-cycle",
		label: "Unplug USB and take the batteries out. Wait 10 seconds. Plug USB back in with no batteries, and press no key while the board starts (Fn+Right Alt held at power-on saves to flash).",
		question: "Did you unplug USB with the batteries out for 10 seconds, and press no key since the write?",
		keylog: null,
	},
	{ kind: "wire", id: "query-after-power", label: "Query the gate: the power cycle closed it", op: "query", expect: CLOSED, request: "41ff0000", reply: "41000000" },
	{ kind: "wire", id: "read-after-power", label: "Read Caps Lock back: the saved store holds 0x00FF", op: "read", expect: { kind: "default" }, request: "52203900", reply: "52203900ff00" },
	{
		kind: "user",
		id: "keylog-after-power",
		label: "Press Caps Lock on the TAB 60 two or three times, and no other key.",
		question: "Did Caps Lock act as Caps Lock again, with the keylog showing CapsLock and no ControlLeft?",
		keylog: TYPES_CAPS_LOCK,
	},
];

export interface Attestation {
	readonly answer: boolean;
	readonly keys: readonly string[];
}

export const attestEntry = (step: UserStep, { answer, keys }: Attestation, t: number): TranscriptEntry => ({ t, kind: "attest", step: step.id, answer, keys: [...keys] });

/** Whether an attestation meets its step: a yes, and for a keylog step the wanted code logged and the other one not. */
export function attestationMet(step: UserStep, { answer, keys }: Attestation): boolean {
	if (!answer) return false;
	if (step.keylog === null) return true;
	return keys.includes(step.keylog.want) && !keys.includes(step.keylog.not);
}

export interface StepOutcome {
	readonly id: string;
	readonly label: string;
	readonly pass: boolean;
	readonly detail: string;
}

const describeGate = ({ gate, timer }: GateState) => `gate 0x${gate.toString(16).padStart(2, "0")} timer ${timer}`;

async function runWire(session: AppSession, step: WireStep, signal: AbortSignal): Promise<{ readonly pass: boolean; readonly detail: string }> {
	const { config } = session;
	switch (step.op) {
		case "query": {
			const got = await config.queryGate(signal);
			return { pass: got.gate === step.expect.gate && got.timer === step.expect.timer, detail: describeGate(got) };
		}
		case "open":
			await config.openGate(signal);
			return { pass: true, detail: "echoed" };
		case "close":
			await config.closeGate(signal);
			return { pass: true, detail: "echoed" };
		case "write":
		case "read": {
			const got = step.op === "write" ? await config.writeKey(BASE, CAPS_LOCK, step.value, signal) : await config.readKey(BASE, CAPS_LOCK, signal);
			return { pass: describeEntry(got) === describeEntry(step.expect), detail: `read back ${describeEntry(got)}` };
		}
		default: {
			const exhaustive: never = step;
			return exhaustive;
		}
	}
}

/**
 * Runs U11_STEPS in order and reports each. `attend` shows a user step and resolves with the user's answer; the caller
 * records it. A session opens at the first wire step after a user step and closes before the next user step. A thrown
 * error stops the run.
 */
export async function runU11(
	port: DevicePort,
	clearance: Clearance,
	attend: (step: UserStep) => Promise<Attestation>,
	onStep: (outcome: StepOutcome) => void,
	signal: AbortSignal,
): Promise<readonly StepOutcome[]> {
	const outcomes: StepOutcome[] = [];
	const report = (outcome: StepOutcome) => {
		outcomes.push(outcome);
		onStep(outcome);
	};
	let session: AppSession | null = null;
	try {
		for (const step of U11_STEPS) {
			if (step.kind === "user") {
				if (session !== null) await session.close();
				session = null;
				const attestation = await attend(step);
				report({ id: step.id, label: step.label, pass: attestationMet(step, attestation), detail: `${attestation.answer ? "yes" : "no"}, keys ${attestation.keys.join(" ") || "none"}` });
				continue;
			}
			if (session === null) {
				const opened = await connect({ port, clearance, signal }, { modes: ["app"], reason: "connect" });
				if ("refusal" in opened) throw new Error(`attach refused: ${opened.refusal.code}`);
				session = opened;
			}
			report({ id: step.id, label: step.label, ...(await runWire(session, step, signal)) });
		}
		return outcomes;
	} finally {
		if (session !== null) await session.close();
	}
}

/** Each sent frame whose bytes 0..1 are not one of the U11 rows. The transcript is the capture only when this is empty. */
export function framesOutsideU11(entries: readonly TranscriptEntry[]): readonly string[] {
	return entries.flatMap((entry) => (entry.kind === "out" && !U11_PAIRS.includes(entry.hex.slice(0, 4)) ? [entry.hex] : []));
}
