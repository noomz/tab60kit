/**
 * What the U1 page shows, derived from the transcript and from what a run returned. DOM-free, so the recovery tests
 * reach the same derivation the page renders.
 */
import { TAB60 } from "../core/device";
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

/** True from a RESET to IAP handed to the link, acknowledged or not, until a normal-mode link opens (F2). */
export function awayFromHome(entries: readonly TranscriptEntry[]): boolean {
	let away = false;
	for (const entry of entries) {
		if (entry.kind === "out" && entry.hex.startsWith(RESET_TO_IAP)) away = true;
		if (entry.kind === "opened" && entry.productId === TAB60.productId.app) away = false;
	}
	return away;
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
