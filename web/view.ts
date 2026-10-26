/**
 * What the page shows for one Screen, as plain data: no DOM here, so the words and the buttons are testable.
 * app.ts draws it. Every Record and switch is exhaustive, so a new activity, finding, or stop reason fails to compile
 * until it has its words.
 */
import {
	type Activity,
	type BootTarget,
	type ChipReport,
	type DeviceWant,
	type Finding,
	type FlashableImage,
	type JobResult,
	type KeymapProblem,
	type OsKeyMode,
	type StopReason,
	TAB60_KEYS,
	type UpdaterReading,
} from "@tab60kit/core";
import type { Screen } from "./screens";

export type Action = "connect" | "deep-check" | "make-official" | "apply" | "pick" | "cancel" | "skip";

export interface FlashRow {
	readonly region: string;
	readonly range: string;
	readonly finding: string;
}

export interface PageView {
	readonly title: string;
	readonly lines: readonly string[];
	readonly flashMap: readonly FlashRow[] | null;
	readonly boot: string | null;
	/** Buttons in display order. */
	readonly actions: readonly Action[];
	/** The Pick button's text, when `actions` has "pick". */
	readonly pickLabel: string | null;
	/** The board cannot type right now: the page shows HOLD_STILL_BANNER and blocks unload. */
	readonly holdStill: boolean;
	/** A udev rule to show, on Linux setups. */
	readonly linuxRule: string | null;
}

const REGION: Readonly<Record<ChipReport["regions"][number]["region"], string>> = {
	bootloader: "Bootloader",
	"version-page": "Version page",
	app: "Firmware",
	"option-bytes": "Option bytes",
};

const BY: Readonly<Record<Extract<Finding, { kind: "official" }>["by"], string>> = {
	"version-page-bytes": "by its bytes",
	sum: "by its sum",
	"sum-and-crc": "by its sum and CRC-32",
};

const BOOT: Readonly<Record<BootTarget, string>> = {
	"normal-mode": "On its next restart the board starts the official firmware and types.",
	"stays-in-update-mode": "On its next restart the board stays in update mode and cannot type until it is flashed.",
	"boots-unchecked-image": "On its next restart the board starts firmware this tool has not checked.",
	"boots-damaged-image": "On its next restart the board would start firmware that failed its checksum. Flash it before unplugging.",
};

const ACTIVITY: { readonly [K in Activity["kind"]]: (activity: Extract<Activity, { kind: K }>) => string } = {
	reading: () => "Reading the board.",
	restarting: (a) => (a.into === "iap" ? "Restarting the board into update mode." : "Restarting the board into normal mode."),
	"holding-link": (a) => `Checking that the USB link is steady before the first write: ${Math.floor(a.quietMs / 1000)} of ${a.needMs / 1000} s. Keep the cable still.`,
	erasing: () => "Erasing.",
	"writing-image": (a) => `Writing the firmware: ${a.chunk} of ${a.chunks}.`,
	"writing-version-block": () => "Writing the version block.",
	"applying-keymap": (a) => `Applying the keymap: ${a.done} of ${a.total}.`,
	"link-lost": (a) => `The USB link dropped (${a.losses}). Reconnecting.`,
};

export function activityText(activity: Activity): string {
	return (ACTIVITY[activity.kind] as (a: Activity) => string)(activity);
}

const hex = (n: number) => `0x${n.toString(16).padStart(5, "0")}`;

function findingText(finding: Finding): string {
	switch (finding.kind) {
		case "not-checkable-over-usb":
			return `Not checkable over USB: ${finding.why}.${finding.fingerprint === null ? "" : ` Fingerprint ${finding.fingerprint.slice(0, 16)}.`}`;
		case "official":
			return `Official ${finding.entry.version}, ${BY[finding.by]}.`;
		case "erased":
			return "Erased.";
		case "unrecognized":
			return `Not recognized: ${finding.detail}.`;
		case "needs-deep-check":
			return "Needs a deep check: only update mode can checksum the firmware.";
		case "not-checked":
			return `Not checked: ${finding.why}.`;
		default: {
			const exhaustive: never = finding;
			return exhaustive;
		}
	}
}

function flashMap(report: ChipReport | null): Pick<PageView, "flashMap" | "boot"> {
	if (report === null) return { flashMap: null, boot: null };
	return {
		flashMap: report.regions.map((row) => ({ region: REGION[row.region], range: `${hex(row.from)}–${hex(row.to)}`, finding: findingText(row.finding) })),
		boot: BOOT[report.boot],
	};
}

export const OS_KEY_MODE_NAME: Readonly<Record<OsKeyMode, string>> = {
	windows: "Windows (Fn+Q)",
	mac: "Mac (Fn+W)",
	"caps-ctrl": "Caps/Ctrl swap (Fn+E)",
};

const UNDO = "Unplugging USB with the batteries out for 10 seconds undoes every write Apply made.";
const gateByte = (gate: number) => `0x${gate.toString(16).padStart(2, "0")}`;
const usages = (list: readonly number[]) => list.map(gateByte).join(" ");

function keymapText(problem: KeymapProblem): string {
	switch (problem.kind) {
		case "mode-disagrees":
			return `The board's keys do not match OS key mode ${OS_KEY_MODE_NAME[problem.mode]}${problem.missing.length > 0 ? `: no key has ${usages(problem.missing)}` : ""}${problem.unexpected.length > 0 ? `${problem.missing.length > 0 ? ", and" : ":"} a key has ${usages(problem.unexpected)}` : ""}. Choose the mode the board runs in and apply again. If Fn or Pn was moved, this editor cannot address the keys. Nothing was written.`;
		case "gate":
			return problem.when === "before"
				? `Another tool holds the board's config gate (it reads ${gateByte(problem.gate)}). Close that tool, then unplug USB with the batteries out for 10 seconds and plug USB back in, which clears the gate, and apply again. Nothing was written.`
				: `The board's config gate still reads ${gateByte(problem.gate)} after Apply closed it. ${UNDO}`;
		case "refused":
			return `The board refused a write (${problem.message}). ${UNDO}`;
		case "read-back": {
			const legend = TAB60_KEYS.find((cap) => cap.id === problem.key)?.legend ?? `key ${problem.key}`;
			return `${legend} on layer ${problem.layer} reads back ${problem.got}, not ${problem.want}. ${UNDO}`;
		}
		default: {
			const exhaustive: never = problem;
			return exhaustive;
		}
	}
}

function stopText(reason: StopReason): string {
	switch (reason.kind) {
		case "cancelled":
			if (reason.during?.kind === "applying-keymap") {
				return `Stopped during Apply: some keys may hold the new keymap and others not, and the config gate may still be open if the board missed the close. Click Apply again to finish. ${UNDO}`;
			}
			return reason.during?.kind === "restarting" && reason.during.into === "iap"
				? "Stopped. The board may be in update mode: click Connect to see where it is."
				: "Stopped.";
		case "board-refused":
			return `This board does not match the TAB 60 this tool knows (${reason.refusal.code}). Nothing was changed.`;
		case "gate":
			return `This build cannot do that yet: ${reason.blocked}.`;
		case "os-permission":
			return "The system refused access to the keyboard.";
		case "busy":
			return "Another tab or program is using the keyboard. Close it and try again.";
		case "attempts-exhausted":
			return `The board refused the same step three times (${reason.step}). Click Connect to see where it is.`;
		case "too-many-link-losses":
			return `The USB link dropped ${reason.losses} times. Try another cable or port, then click Connect.`;
		case "keymap":
			return keymapText(reason.problem);
		case "error":
			return `Something went wrong in this tool: ${reason.message}`;
		default: {
			const exhaustive: never = reason;
			return exhaustive;
		}
	}
}

function resultText(result: JobResult): string {
	switch (result.kind) {
		case "checked":
			return result.depth === "deep" ? "Deep check done." : "Checked.";
		case "official":
			return `The board runs official ${result.entry.version}.${result.confirmedInNormalMode ? "" : " Restart it to confirm it types."}`;
		case "keymap-applied":
			return `Keymap applied (${result.writes} keys).`;
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}

const idle: Pick<PageView, "pickLabel" | "holdStill" | "linuxRule"> = { pickLabel: null, holdStill: false, linuxRule: null };

export const HOLD_STILL_BANNER = "Hold still: the keyboard cannot type now. Do not unplug it, close this tab, or switch away from it.";

/** The first image the dropped exe holds that `admit` let through, which Make official writes. */
export function admittedImage(reading: UpdaterReading | null): FlashableImage | null {
	if (reading?.kind !== "read") return null;
	for (const { admission } of reading.images) if (admission.kind === "admitted") return admission.image;
	return null;
}

const boardActions = (reading: UpdaterReading | null): readonly Action[] => ["connect", "deep-check", ...(admittedImage(reading) === null ? [] : ["make-official" as const])];

/** What the Board, result, and Stopped screens say about the dropped exe: each image's admission, and what Make official does first. */
function readingLines(reading: UpdaterReading | null): readonly string[] {
	if (reading === null) return ["To flash official firmware, drop Tab60firmwareV1.01.13.exe (from vortexgear.tw) on the file picker below. The page reads it here and uploads nothing."];
	if (reading.kind === "refused") return [`That file is not a TAB 60 updater this page can read (${reading.refusal.code}).`];
	const lines = reading.images.map(({ slot, layoutName, admission }) =>
		admission.kind === "admitted" ? `Slot ${slot + 1}, ${layoutName}: official ${admission.image.entry.version}, ready to flash.` : `Slot ${slot + 1}, ${layoutName}: not flashable (${admission.refusal.code}).`,
	);
	if (admittedImage(reading) !== null) {
		lines.push(
			"Make official first checks the USB link for 15 seconds and writes nothing until it holds. Keep the cable still and this tab in front. The keyboard cannot type for about 35 seconds. If the cable drops, click Reconnect and pick whichever row appears.",
		);
	}
	return lines;
}

/** After a job, the exe's lines show once one was dropped; the Board screen alone prompts for one. */
const droppedLines = (reading: UpdaterReading | null) => (reading === null ? [] : readingLines(reading));

/** `needsClick` is the chooser's parked request: a pick then needs this page's click to open the chooser. */
export function viewFor(screen: Screen, needsClick: DeviceWant | null): PageView {
	switch (screen.name) {
		case "browser-gate":
			return {
				...idle,
				title: "Use Chrome or Edge",
				lines: [screen.why === "no-webhid" ? "This browser cannot talk to USB keyboards (no WebHID)." : "Open this page over HTTPS or from localhost."],
				flashMap: null,
				boot: null,
				actions: [],
			};
		case "connect":
			return { ...idle, title: "Connect your TAB 60", lines: ["Plug the keyboard in by USB, then click Connect and pick it in the chooser."], flashMap: null, boot: null, actions: ["connect"] };
		case "device-prompt": {
			const lines = [needsClick === null ? `In the chooser, pick ${screen.pickRow}.` : `Click Pick, then choose ${screen.pickRow}.`];
			if (screen.reason === "enter-update-mode") lines.push("The board is restarting into update mode. It shows up as a new device.");
			if (screen.skippable) lines.push("Skip if you do not need the confirmation; the board is already home.");
			return {
				...idle,
				title: "Pick the keyboard",
				lines,
				flashMap: null,
				boot: null,
				actions: [...(needsClick === null ? [] : ["pick" as const]), screen.skippable ? "skip" : "cancel"],
				pickLabel: needsClick === null ? null : `Pick ${screen.pickRow}`,
				holdStill: screen.reason !== "connect",
			};
		}
		case "board":
			return { ...idle, title: "Your board", lines: readingLines(screen.reading), ...flashMap(screen.report), actions: boardActions(screen.reading) };
		case "progress":
			return {
				...idle,
				title: "Working",
				lines: [activityText(screen.activity)],
				...flashMap(screen.report),
				actions: ["cancel"],
				holdStill: screen.holdStill,
			};
		case "result":
			return { ...idle, title: resultText(screen.result), lines: droppedLines(screen.reading), ...flashMap(screen.report), actions: boardActions(screen.reading) };
		case "stopped":
			return { ...idle, title: "Stopped", lines: [stopText(screen.reason), ...droppedLines(screen.reading)], ...flashMap(screen.report), actions: boardActions(screen.reading) };
		case "os-permission":
			return {
				...idle,
				title: "Allow access to the keyboard",
				lines: ["Linux needs a udev rule before a browser may open the keyboard. Add this rule, replug the keyboard, then click Connect."],
				flashMap: null,
				boot: null,
				actions: ["connect"],
				linuxRule: screen.linuxRule,
			};
		default: {
			const exhaustive: never = screen;
			return exhaustive;
		}
	}
}
