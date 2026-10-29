/**
 * Every screen, derived from one JobState. No screen keeps its own copy of board or job facts.
 * The switch is exhaustive, so a new JobState variant fails to compile until it has a screen.
 */
import {
	type Activity,
	type ChipReport,
	type ChipState,
	type ConfigCapabilities,
	type FlashableImage,
	type JobResult,
	type JobState,
	type KeymapDoc,
	OPEN_FIRMWARE_PREREQUISITES,
	type OpenFirmwarePrerequisite,
	type StopReason,
	TAB60,
	type UpdaterReading,
	type WantReason,
	bootTarget,
	report,
	udevRules,
} from "@tab60kit/core";

export type AppView =
	| { readonly kind: "unsupported"; readonly why: "no-webhid" | "insecure-context" }
	| {
			readonly kind: "kit";
			readonly state: JobState;
			readonly reading: UpdaterReading | null;
			readonly keymap: KeymapDoc;
			readonly caps: ConfigCapabilities;
	  };

/**
 * What the install button needs on the Board, result, and Stopped screens: the dropped exe's reading, kept across jobs, and
 * one line per flash row G1 does not clear for this kit. The action shows only when that list is empty.
 */
export interface FlashOffer {
	readonly reading: UpdaterReading | null;
	readonly blockedBy: readonly string[];
	/** Whether the board already holds the dropped image (see `installedAs`). */
	readonly installed: Installed;
}

/**
 * "verified": update mode checksummed the image and it is the dropped one, under its version page, so the install
 * would write nothing (flash.ts decideInIap, rewrite off). "reported": only the version page names it; the image is
 * unchecked, so the install still checks and writes if it differs. null: anything else.
 */
export type Installed = "verified" | "reported" | null;

/** The first image the dropped exe holds that `admit` let through, which the install writes. */
export function admittedImage(reading: UpdaterReading | null): FlashableImage | null {
	if (reading?.kind !== "read") return null;
	for (const { admission } of reading.images) if (admission.kind === "admitted") return admission.image;
	return null;
}

export function installedAs(board: ChipState | null, image: FlashableImage | null): Installed {
	if (board === null || image === null || board.page.kind !== "official" || board.page.entry.id !== image.entry.id) return null;
	if (board.mode === "app") return "reported";
	return board.image.kind === "official" && board.image.entry.id === image.entry.id ? "verified" : null;
}

export type Screen =
	/** Firefox and Safari ship no WebHID (docs/webhid.md B1, B2). */
	| { readonly name: "browser-gate"; readonly why: "no-webhid" | "insecure-context" }
	| { readonly name: "connect"; readonly linuxRule: string }
	/** The pick button calls port.pick() from its click. `pickRow` is the chooser row to choose. */
	| { readonly name: "device-prompt"; readonly reason: WantReason; readonly pickRow: string; readonly skippable: boolean }
	| {
			readonly name: "board";
			readonly report: ChipReport;
			readonly flash: FlashOffer;
			readonly keymapLockedBy: readonly string[];
			readonly openFirmware: readonly OpenFirmwarePrerequisite[];
	  }
	/** `holdStill`: the board cannot type, so the page says not to unplug and blocks unload. */
	| { readonly name: "progress"; readonly activity: Activity; readonly holdStill: boolean; readonly report: ChipReport | null }
	| { readonly name: "result"; readonly result: JobResult; readonly report: ChipReport | null; readonly flash: FlashOffer }
	| { readonly name: "stopped"; readonly reason: StopReason; readonly report: ChipReport | null; readonly flash: FlashOffer }
	| { readonly name: "os-permission"; readonly linuxRule: string };

/**
 * Whether the board can type during each activity. A Record over every kind, so a new activity fails to compile
 * until someone decides whether it is safe to unplug during it.
 */
const HOLD_STILL: Readonly<Record<Activity["kind"], boolean>> = {
	reading: false,
	restarting: true,
	"holding-link": true,
	erasing: true,
	"writing-image": true,
	"writing-version-block": true,
	"applying-keymap": false,
	"link-lost": false,
};

export function screenFor(view: AppView): Screen {
	if (view.kind === "unsupported") return { name: "browser-gate", why: view.why };
	const { state } = view;
	const flashMap = state.board ? report(state.board) : null;
	const flash: FlashOffer = { reading: view.reading, blockedBy: view.caps.flashBlockedBy, installed: installedAs(state.board, admittedImage(view.reading)) };
	switch (state.kind) {
		case "idle":
			return state.board
				? {
						name: "board",
						report: report(state.board),
						flash,
						keymapLockedBy: view.caps.blockedBy,
						openFirmware: OPEN_FIRMWARE_PREREQUISITES,
					}
				: { name: "connect", linuxRule: udevRules() };
		case "awaiting-device": {
			const mode = state.want.modes.length === 1 ? state.want.modes[0] : undefined;
			return {
				name: "device-prompt",
				reason: state.want.reason,
				pickRow: mode ? TAB60.productName[mode] : `${TAB60.productName.app} or ${TAB60.productName.iap}`,
				skippable: state.want.reason === "confirm-normal-mode",
			};
		}
		case "working":
			return {
				name: "progress",
				activity: state.activity,
				holdStill:
					HOLD_STILL[state.activity.kind] ||
					(state.board !== null && bootTarget(state.board) === "stays-in-update-mode"),
				report: flashMap,
			};
		case "finished":
			return { name: "result", result: state.result, report: flashMap, flash };
		case "stopped":
			return state.reason.kind === "os-permission"
				? { name: "os-permission", linuxRule: udevRules() }
				: { name: "stopped", reason: state.reason, report: flashMap, flash };
		default: {
			const exhaustive: never = state;
			return exhaustive;
		}
	}
}
