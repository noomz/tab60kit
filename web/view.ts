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
	type JobState,
	type KeymapProblem,
	LAYER_KEY_MARKERS,
	type OsKeyMode,
	type StopReason,
	TAB60_KEYS,
	type UpdaterReading,
} from "@tab60kit/core";
import type { FlashOffer, Screen } from "./screens";

export type Action = "connect" | "deep-check" | "install" | "apply" | "pick" | "cancel" | "skip";

/** The page's semantic colors: cobalt confirms, orange asks for attention, grey is not checked. No red or green. */
export type Tone = "plain" | "confirmed" | "attention" | "muted";

export interface FlashRow {
	readonly region: string;
	readonly range: string;
	/** What the row means for the user, in plain words. */
	readonly finding: string;
	/** The exact technical reason, for a disclosure under the row, or null when the plain words are the whole story. */
	readonly detail: string | null;
	readonly tone: Tone;
}

/** What each dot color in the flash map means. */
export const FLASH_LEGEND: readonly { readonly tone: Tone; readonly text: string }[] = [
	{ tone: "confirmed", text: "Cobalt: matches the official firmware." },
	{ tone: "attention", text: "Orange: needs your attention." },
	{ tone: "muted", text: "Grey: can't be verified over USB, or not checked yet. This is expected." },
];

export interface PageView {
	readonly title: string;
	/** The color of the panel that holds the title and lines. */
	readonly tone: Tone;
	readonly lines: readonly string[];
	readonly flashMap: readonly FlashRow[] | null;
	readonly boot: { readonly text: string; readonly tone: Tone } | null;
	/** Buttons in display order. */
	readonly actions: readonly Action[];
	/** The one action drawn as the main button, or null when every button is secondary. */
	readonly primary: Action | null;
	/** A counted activity, drawn as a progress bar under its line. */
	readonly progress: { readonly done: number; readonly total: number } | null;
	/** The Pick button's text, when `actions` has "pick". */
	readonly pickLabel: string | null;
	/** The install button's text, naming the version it writes, when `actions` has "install". */
	readonly installLabel: string | null;
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

const BOOT: Readonly<Record<BootTarget, { readonly text: string; readonly tone: Tone }>> = {
	"normal-mode": { text: "When the keyboard restarts, it runs the official firmware and types normally.", tone: "confirmed" },
	"stays-in-update-mode": { text: "When the keyboard restarts, it stays in update mode and can't type until official firmware is installed.", tone: "attention" },
	"boots-unchecked-image": { text: "When the keyboard restarts, it runs its current firmware, which this tool hasn't verified.", tone: "muted" },
	"boots-damaged-image": { text: "When the keyboard restarts, it would run firmware that failed its checksum. Install the official firmware before you unplug it.", tone: "attention" },
};

const FINDING_TONE: Readonly<Record<Finding["kind"], Tone>> = {
	official: "confirmed",
	"not-checkable-over-usb": "muted",
	"not-checked": "muted",
	"needs-deep-check": "muted",
	erased: "attention",
	unrecognized: "attention",
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

function technicalText(finding: Finding): string {
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

type Region = ChipReport["regions"][number]["region"];

/** The plain words for a row. Rows that only say "not verified" also say why that is normal; the technical reason goes in `detail`. */
function plainText(region: Region, finding: Finding): string {
	switch (finding.kind) {
		case "not-checkable-over-usb":
			if (region === "bootloader") return "Can't be read over USB, which is normal. This tool never writes the bootloader.";
			if (region === "option-bytes") return "No USB command reads these, which is normal. This tool never writes them.";
			return "Can't be read over USB, which is normal. This tool never writes it.";
		case "not-checked":
			return "The space after the firmware, normally empty. Not verified.";
		case "needs-deep-check":
			return "Not verified yet. Deep check verifies it.";
		case "unrecognized":
			return region === "version-page" ? "Doesn't match an official version this tool knows." : "Doesn't match official firmware this tool knows.";
		case "official":
		case "erased":
			return technicalText(finding);
		default: {
			const exhaustive: never = finding;
			return exhaustive;
		}
	}
}

function flashRow({ region, from, to, finding }: ChipReport["regions"][number]): FlashRow {
	const plain = plainText(region, finding);
	const technical = technicalText(finding);
	return { region: REGION[region], range: `${hex(from)}–${hex(to)}`, finding: plain, detail: plain === technical ? null : technical, tone: FINDING_TONE[finding.kind] };
}

function flashMap(report: ChipReport | null): Pick<PageView, "flashMap" | "boot"> {
	if (report === null) return { flashMap: null, boot: null };
	return {
		flashMap: report.regions.map(flashRow),
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

/** A plain sentence for each layer key the board's read showed on no key at all, or "" when both are there. */
const lostLayerKeys = (missing: readonly number[]) =>
	LAYER_KEY_MARKERS.filter((marker) => missing.includes(marker.usage))
		.map((marker) => `No key on the board works as ${marker.what} now, so its layer cannot be reached. `)
		.join("");

function keymapText(problem: KeymapProblem): string {
	switch (problem.kind) {
		case "mode-disagrees":
			return `${lostLayerKeys(problem.missing)}The board's keys do not match OS key mode ${OS_KEY_MODE_NAME[problem.mode]}${problem.missing.length > 0 ? `: no key has ${usages(problem.missing)}` : ""}${problem.unexpected.length > 0 ? `${problem.missing.length > 0 ? ", and" : ":"} a key has ${usages(problem.unexpected)}` : ""}. Choose the mode the board runs in and apply again. If Fn or Pn was moved, this editor cannot address the keys. Nothing was written.`;
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

/** Only a flash ends confirmed: a check reports what it found in the flash map, and an applied keymap is live, not saved. */
const RESULT_TONE: Readonly<Record<JobResult["kind"], Tone>> = { checked: "plain", official: "confirmed", "keymap-applied": "plain" };

const idle: Pick<PageView, "tone" | "pickLabel" | "installLabel" | "holdStill" | "linuxRule" | "progress"> = { tone: "plain", pickLabel: null, installLabel: null, holdStill: false, linuxRule: null, progress: null };

/** The main button: the pick a parked chooser waits on, then the install, then the first action unless it only stops. */
function primaryOf(actions: readonly Action[]): Action | null {
	if (actions.includes("pick")) return "pick";
	if (actions.includes("install")) return "install";
	const first = actions[0];
	return first === undefined || first === "cancel" || first === "skip" ? null : first;
}

const withPrimary = (view: Omit<PageView, "primary">): PageView => ({ ...view, primary: primaryOf(view.actions) });

function progressOf(activity: Activity): PageView["progress"] {
	switch (activity.kind) {
		case "writing-image":
			return { done: activity.chunk, total: activity.chunks };
		case "applying-keymap":
			return { done: activity.done, total: activity.total };
		case "holding-link":
			return { done: Math.min(activity.quietMs, activity.needMs), total: activity.needMs };
		default:
			return null;
	}
}

/** A plain Stop leaves nothing to fix; a Stop that may have left the board mid-change asks for attention, as every other stop does. */
function stopTone(reason: StopReason): Tone {
	if (reason.kind !== "cancelled") return "attention";
	return reason.during?.kind === "applying-keymap" || (reason.during?.kind === "restarting" && reason.during.into === "iap") ? "attention" : "plain";
}

export interface StatusChip {
	/** `live` is the dashed cobalt mark: a keymap on the board's memory and not saved on the board. */
	readonly kind: "idle" | "normal" | "update" | "wait" | "lost" | "live";
	readonly label: string;
}

/** The header's chips: where the board was last seen, and whether a keymap this page applied is live on it. */
export function statusChips(state: JobState, needsClick: DeviceWant | null): readonly StatusChip[] {
	const chips: StatusChip[] = [];
	if (state.kind === "finished" && state.result.kind === "keymap-applied") chips.push({ kind: "live", label: "Keymap live, not saved on the keyboard" });
	if (state.kind === "awaiting-device") chips.push({ kind: "wait", label: needsClick === null ? "Pick in the chooser" : "Waiting for your pick" });
	else if (state.kind === "working" && state.activity.kind === "link-lost") chips.push({ kind: "lost", label: "USB link dropped" });
	else if (state.board === null) chips.push({ kind: "idle", label: "Not connected" });
	else chips.push(state.board.mode === "app" ? { kind: "normal", label: "TAB 60 · normal mode" } : { kind: "update", label: "TAB 60 · update mode" });
	return chips;
}

export const HOLD_STILL_BANNER = "Hold still: the keyboard cannot type now. Do not unplug it, close this tab, or switch away from it.";

/** The first image the dropped exe holds that `admit` let through, which the install writes. */
export function admittedImage(reading: UpdaterReading | null): FlashableImage | null {
	if (reading?.kind !== "read") return null;
	for (const { admission } of reading.images) if (admission.kind === "admitted") return admission.image;
	return null;
}

const canInstall = ({ reading, blockedBy }: FlashOffer) => admittedImage(reading) !== null && blockedBy.length === 0;

/** The Board, result, and Stopped screens' buttons, and the install button's text when there is one. */
function boardActions(flash: FlashOffer): Pick<PageView, "actions" | "installLabel"> {
	const image = canInstall(flash) ? admittedImage(flash.reading) : null;
	return image === null
		? { actions: ["connect", "deep-check"], installLabel: null }
		: { actions: ["connect", "deep-check", "install"], installLabel: `Install official firmware ${image.entry.version}` };
}

/**
 * What the install does. Saved settings: the flash writes only the MCU's firmware window, and the firmware saves its
 * profiles to a separate SPI flash (docs/app-firmware.md). Apply's keys live in RAM, which the restart clears. A board
 * that already holds the image is checked and not written (flash.ts decideInIap, rewrite off). The time is U7's run:
 * the 15 s link gate, then about 2 s of erase and 663 writes, plus the two picks.
 */
const installText = (version: string) =>
	`Install official firmware ${version} replaces the firmware on the keyboard with the copy in your updater. Settings the keyboard saved, such as its profiles and OS key mode, are kept: they are stored apart from the firmware. Keys set with Apply are lost when the keyboard restarts, so click Apply again afterwards. If the keyboard already runs ${version}, it is checked and nothing is written. It takes about 20 seconds plus two picks in the chooser: a 15-second USB link check, then about 2 seconds of writing.`;

/**
 * What the Board, result, and Stopped screens say about the dropped exe: each image's admission, and either what
 * the install does or why this build cannot flash.
 */
function readingLines({ reading, blockedBy }: FlashOffer): readonly string[] {
	if (reading === null) return ["To flash official firmware, drop Tab60firmwareV1.01.13.exe (from vortexgear.tw) on the file picker below. The page reads it here and uploads nothing."];
	if (reading.kind === "refused") return [`That file is not a TAB 60 updater this page can read (${reading.refusal.code}).`];
	const lines = reading.images.map(({ slot, layoutName, admission }) =>
		admission.kind === "admitted" ? `Slot ${slot + 1}, ${layoutName}: official ${admission.image.entry.version}, ready to flash.` : `Slot ${slot + 1}, ${layoutName}: not flashable (${admission.refusal.code}).`,
	);
	const image = admittedImage(reading);
	if (image === null) return lines;
	if (blockedBy.length > 0) return [...lines, `This build cannot flash yet: ${blockedBy[0]}.`];
	return [
		...lines,
		installText(image.entry.version),
		"It writes nothing until the USB link has held steady for 15 seconds. Keep the cable still and this tab in front. The keyboard cannot type from then until the page says the install is done. If the cable drops, click the Pick button and choose whichever row appears.",
	];
}

/** After a job, the exe's lines show once one was dropped; the Board screen alone prompts for one. */
const droppedLines = (flash: FlashOffer) => (flash.reading === null ? [] : readingLines(flash));

/** `needsClick` is the chooser's parked request: a pick then needs this page's click to open the chooser. */
export function viewFor(screen: Screen, needsClick: DeviceWant | null): PageView {
	switch (screen.name) {
		case "browser-gate":
			return withPrimary({
				...idle,
				tone: "attention",
				title: "Use Chrome or Edge",
				lines: [screen.why === "no-webhid" ? "This browser cannot talk to USB keyboards (no WebHID)." : "Open this page over HTTPS or from localhost."],
				flashMap: null,
				boot: null,
				actions: [],
			});
		case "connect":
			return withPrimary({ ...idle, title: "Connect your TAB 60", lines: ["Plug the keyboard in by USB, then click Connect and pick it in the chooser."], flashMap: null, boot: null, actions: ["connect"] });
		case "device-prompt": {
			const lines = [needsClick === null ? `In the chooser, pick ${screen.pickRow}.` : `Waiting for you: click Pick ${screen.pickRow}, then choose ${screen.pickRow}.`];
			if (screen.reason === "enter-update-mode") lines.push("The board is restarting into update mode. It shows up as a new device.");
			if (screen.skippable) lines.push("Skip if you do not need the confirmation; the board is already home.");
			return withPrimary({
				...idle,
				title: "Pick the keyboard",
				lines,
				flashMap: null,
				boot: null,
				actions: [...(needsClick === null ? [] : ["pick" as const]), screen.skippable ? "skip" : "cancel"],
				pickLabel: needsClick === null ? null : `Pick ${screen.pickRow}`,
				holdStill: screen.reason !== "connect",
			});
		}
		case "board":
			return withPrimary({ ...idle, title: "Your board", lines: readingLines(screen.flash), ...flashMap(screen.report), ...boardActions(screen.flash) });
		case "progress":
			return withPrimary({
				...idle,
				title: "Working",
				lines: [activityText(screen.activity)],
				...flashMap(screen.report),
				actions: ["cancel"],
				holdStill: screen.holdStill,
				progress: progressOf(screen.activity),
			});
		case "result":
			return withPrimary({ ...idle, tone: RESULT_TONE[screen.result.kind], title: resultText(screen.result), lines: droppedLines(screen.flash), ...flashMap(screen.report), ...boardActions(screen.flash) });
		case "stopped":
			return withPrimary({ ...idle, tone: stopTone(screen.reason), title: "Stopped", lines: [stopText(screen.reason), ...droppedLines(screen.flash)], ...flashMap(screen.report), ...boardActions(screen.flash) });
		case "os-permission":
			return withPrimary({
				...idle,
				tone: "attention",
				title: "Allow access to the keyboard",
				lines: ["Linux needs a udev rule before a browser may open the keyboard. Add this rule, replug the keyboard, then click Connect."],
				flashMap: null,
				boot: null,
				actions: ["connect"],
				linuxRule: screen.linuxRule,
			});
		default: {
			const exhaustive: never = screen;
			return exhaustive;
		}
	}
}
