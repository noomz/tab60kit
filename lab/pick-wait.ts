import { TAB60 } from "../core/device";
import type { DeviceWant } from "../core/port";
import type { Chooser } from "../web/webhid-port";

/** The Pick button's text on the U7, U10, U11, and U12 lab pages. */
export const PICK_BUTTON = "Pick the TAB 60";

export function waitingForPick(want: DeviceWant): string {
	return `Waiting for you: click ${PICK_BUTTON}, then choose ${want.modes.map((mode) => TAB60.productName[mode]).join(" or ")}.`;
}

export interface PickButton {
	hidden: boolean;
	readonly style: { fontWeight: string; fontSize: string };
	focus(): void;
	addEventListener(type: "click", listener: () => void): void;
}

/** The Pick button is the one control that matters while a pick waits, so it stands out from the page's others. */
export function prominent(pick: Pick<PickButton, "style">): void {
	pick.style.fontWeight = "bold";
	pick.style.fontSize = "1.25em";
}

/**
 * While a pick is parked, the run is waiting on the user, not working: the button shows, large and focused, and
 * `summary` says what to click in place of the run's "Running...", which comes back after the pick unless the run
 * wrote its own text meanwhile. The 2026-10-28 U7 run sat parked for 565 s and 169 s behind "Running...".
 */
export function showParkedPick(chooser: Chooser, pick: PickButton, summary: { textContent: string | null }): void {
	prominent(pick);
	pick.addEventListener("click", () => chooser.pick());
	let running: string | null = null;
	let waiting: string | null = null;
	chooser.subscribe(() => {
		const want = chooser.needsClick;
		pick.hidden = want === null;
		if (want !== null) {
			if (waiting === null) running = summary.textContent;
			waiting = waitingForPick(want);
			summary.textContent = waiting;
			pick.focus();
		} else if (waiting !== null) {
			if (summary.textContent === waiting) summary.textContent = running;
			waiting = null;
		}
	});
}
