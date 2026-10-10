/** DOM-free, so the recovery tests reach the same derivation the page renders. */
import { TAB60, modeOf } from "../core/device";
import { type DeviceWant, type Mode, PickCancelled, type WantReason } from "../core/port";
import type { AppRefused, AppSession, IapRefused, Refused } from "../core/protocol";
import type { TranscriptEntry } from "../testing/transcript";

export type Run = "connect" | "deep-check" | "try-again" | "restart";

export type Phase =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly what: Run }
	| { readonly kind: "connected"; readonly app: AppSession }
	| { readonly kind: "refused"; readonly refused: AppRefused }
	/** The board may be in update mode, where it cannot type. `holding` is a refused update-mode link the page still holds. */
	| { readonly kind: "away"; readonly holding: IapRefused | null }
	| { readonly kind: "failed" };

/** What a run left open, or how it stopped. */
export type RunOutcome =
	| { readonly kind: "connected"; readonly app: AppSession }
	| { readonly kind: "refused"; readonly refused: Refused }
	| { readonly kind: "none" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "failed" };

const RESET_TO_IAP = "1100";

/**
 * True from a RESET to IAP handed to the link, acknowledged or not, or from an update-mode device granted at load,
 * until a normal-mode link opens (F2).
 */
export function awayFromHome(entries: readonly TranscriptEntry[]): boolean {
	let away = false;
	for (const entry of entries) {
		if (entry.kind === "out" && entry.hex.startsWith(RESET_TO_IAP)) away = true;
		if (entry.kind === "granted" && entry.productId === TAB60.productId.iap) away = true;
		if (entry.kind === "opened" && entry.productId === TAB60.productId.app) away = false;
	}
	return away;
}

/**
 * True from an update-mode link's `opened` entry until its own `closed` or `lost` entry, or another `opened` entry,
 * follows it. A close tagged with normal mode belongs to the keyboard link that enterIap closes while the bootloader
 * link opens, so that close may land after the bootloader's `opened` entry. An untagged close, from an older
 * transcript, ends the link.
 */
export function updateModeLinkOpen(entries: readonly TranscriptEntry[]): boolean {
	let open = false;
	for (const entry of entries) {
		if (entry.kind === "opened") open = entry.productId === TAB60.productId.iap;
		if ((entry.kind === "closed" || entry.kind === "lost") && entry.mode !== "app") open = false;
	}
	return open;
}

/** Only a run that holds an update-mode session sends RESET to app when cancelled. Any other Cancel only stops it. */
export function cancelLabel(entries: readonly TranscriptEntry[]): string {
	return updateModeLinkOpen(entries) ? "Stop and send the board home" : "Stop";
}

/** The recovery text, for an away page and for a run that waits on a parked pick while the board may be away. */
export function showsRecovery(phase: Phase, parked: DeviceWant | null, entries: readonly TranscriptEntry[]): boolean {
	return phase.kind === "away" || (phase.kind === "running" && parked !== null && awayFromHome(entries));
}

/** A link the run left open decides the phase. With none, the transcript says whether the board may be away. */
export function phaseAfterRun(entries: readonly TranscriptEntry[], outcome: RunOutcome): Phase {
	switch (outcome.kind) {
		case "connected":
			return { kind: "connected", app: outcome.app };
		case "refused":
			return outcome.refused.mode === "app" ? { kind: "refused", refused: outcome.refused } : { kind: "away", holding: outcome.refused };
		case "none":
		case "cancelled":
		case "failed":
			if (awayFromHome(entries)) return { kind: "away", holding: null };
			return outcome.kind === "failed" ? { kind: "failed" } : { kind: "idle" };
		default: {
			const exhaustive: never = outcome;
			return exhaustive;
		}
	}
}

type Granted = Extract<TranscriptEntry, { kind: "granted" }>;

/** The part of WebHID the page reads at load. */
interface Grants {
	getDevices(): Promise<readonly Pick<HIDDevice, "vendorId" | "productId">[]>;
}

/**
 * Where the page starts, before any click and with no frame sent. It records one `granted` entry per TAB 60 device
 * the browser still grants, and starts away when one of them is the bootloader, which an earlier page left there.
 */
export async function atLoad(hid: Grants, now: () => number): Promise<{ readonly entries: readonly Granted[]; readonly phase: Phase }> {
	const devices = await hid.getDevices();
	const entries = devices.flatMap((device) => (device.vendorId === TAB60.vendorId && modeOf(device.productId) !== null ? [{ t: now(), kind: "granted" as const, productId: device.productId }] : []));
	return { entries, phase: awayFromHome(entries) ? { kind: "away", holding: null } : { kind: "idle" } };
}

/** A Cancel click and a closed chooser are the user's choice. Anything else failed. */
export function outcomeOfError(error: unknown): RunOutcome {
	const cancelled = error instanceof PickCancelled || (error instanceof DOMException && error.name === "AbortError");
	return { kind: cancelled ? "cancelled" : "failed" };
}

const hex = (n: number) => `0x${n.toString(16).padStart(4, "0")}`;
const ROW: Readonly<Record<Mode, string>> = {
	iap: `${TAB60.productName.iap} (${hex(TAB60.productId.iap)})`,
	app: `the TAB 60 keyboard (${hex(TAB60.productId.app)})`,
};

/** The Pick button names the row the parked pick waits for. */
export function pickLabel(want: DeviceWant | null): string {
	return want === null ? "Pick" : `Pick ${want.modes.map((mode) => ROW[mode]).join(" or ")}`;
}

const HINT: Readonly<Record<WantReason, string>> = {
	connect: `Click Pick and choose the TAB 60 keyboard, listed as ${TAB60.productName.app}.`,
	"enter-update-mode": `Click Pick and choose ${TAB60.productName.iap}.`,
	"confirm-normal-mode": `Click Pick and choose the TAB 60 keyboard, listed as ${TAB60.productName.app}, so the page can confirm the board is back in normal mode.`,
	"after-link-loss": `Click Pick and choose the TAB 60 keyboard or ${TAB60.productName.iap}.`,
};

/** The line next to the Pick button (F12). A long run lets the click's activation lapse, so the confirm pick parks. */
export function pickHint(want: DeviceWant | null): string | null {
	return want === null ? null : HINT[want.reason];
}

export const AWAY_RECOVERY = [
	"The board may still be in update mode, where the keyboard cannot type. Keep this tab open until it is back.",
	"Try again runs the update-mode checks again and then sends the board home.",
	"Restart into normal mode sends RESET to app and then asks you to confirm the keyboard.",
	"If the keyboard already types again, Connect confirms that it is back in normal mode.",
	"If none of these works, unplug the cable, take the batteries out for 10 seconds, and put them back. A cold boot clears the SRAM magic that RESET to IAP set.",
	"Or run the vendor updater with -force on MaruStation.",
	"Keep this tab visible during a run. A hidden tab slows its timers.",
].join("\n");

/** The session conditions the U1 G1 lift requires. The page records each key in the transcript's environment. */
export const PRECONDITIONS = [
	{ key: "cableIn", label: "The cable is in" },
	{ key: "karabinerLedOff", label: "Karabiner's LED manipulation is off" },
	{ key: "secondKeyboardAtHand", label: "A second keyboard is at hand" },
] as const;

export type PreconditionKey = (typeof PRECONDITIONS)[number]["key"];

const PRECONDITION_MET = "yes";

/** The boxes lock when the first frame goes out, so what they say holds for the whole run. */
export const preconditionsLocked = (entries: readonly TranscriptEntry[]): boolean => entries.some((entry) => entry.kind === "out");

/** The entry a box change records, or null once the boxes are locked and the change does nothing. */
export function preconditionChange(entries: readonly TranscriptEntry[], key: PreconditionKey, met: boolean, t: number): TranscriptEntry | null {
	return preconditionsLocked(entries) ? null : { t, kind: "precondition", key, met };
}

/** The keys whose box is ticked after `entries`. Every box starts unticked. */
export function tickedBoxes(entries: readonly TranscriptEntry[]): ReadonlySet<string> {
	const on = new Set<string>();
	for (const entry of entries) {
		if (entry.kind !== "precondition") continue;
		if (entry.met) on.add(entry.key);
		else on.delete(entry.key);
	}
	return on;
}

/** The environment keys the page records, each "yes" or "no" as the box entries leave it. */
export function preconditionEnvironment(entries: readonly TranscriptEntry[]): Record<string, string> {
	const on = tickedBoxes(entries);
	return Object.fromEntries(PRECONDITIONS.map(({ key }) => [key, on.has(key) ? PRECONDITION_MET : "no"]));
}

/**
 * The labels of the preconditions that did not hold for the whole run. The environment must record each as met. A box
 * entry before the first frame must not leave it unticked, and none may follow that frame. A transcript from a page
 * that did not record its boxes has no box entries, so its environment alone decides.
 */
export function unmetPreconditions({ environment, entries }: { readonly environment: Readonly<Record<string, string>>; readonly entries: readonly TranscriptEntry[] }): string[] {
	const first = entries.findIndex((entry) => entry.kind === "out");
	const cut = first === -1 ? entries.length : first;
	const atFirstFrame = new Map<string, boolean>();
	for (const entry of entries.slice(0, cut)) if (entry.kind === "precondition") atFirstFrame.set(entry.key, entry.met);
	const changed = new Set(entries.slice(cut).flatMap((entry) => (entry.kind === "precondition" ? [entry.key] : [])));
	return PRECONDITIONS.filter(({ key }) => environment[key] !== PRECONDITION_MET || atFirstFrame.get(key) === false || changed.has(key)).map(({ label }) => label);
}
