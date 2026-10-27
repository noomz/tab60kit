// expect: none
// The call sites from design.md "Usage (caller's view)", compiled against the sketch. If the usage and the types
// drift apart, this file stops compiling. Only the UI-facing entry point (core/index) and the shell are imported.
import {
	type FlashableImage,
	type JobState,
	type KeymapDoc,
	type Layer,
	type UpdaterReading,
	keyId,
	readUpdater,
	usage,
} from "../core/index";
import { startWebHid } from "../web/webhid-port";
import { type Screen, screenFor } from "../web/screens";

declare function paint(screen: Screen): void;
declare function lockedEditor(blockedBy: readonly string[]): void;
declare const connectButton: HTMLButtonElement;
declare const pickButton: HTMLButtonElement;
declare const makeOfficialButton: HTMLButtonElement;
declare const admittedImage: FlashableImage;

let reading: UpdaterReading | null = null;
const keymap: KeymapDoc = { overrides: new Map(), osMode: null };

// web/main.ts
const { kit, chooser } = startWebHid(navigator.hid, navigator.locks);
kit.subscribe((state) => paint(screenFor({ kind: "kit", state, reading, keymap, caps: kit.capabilities() })));

connectButton.onclick = () => kit.check("quick");
pickButton.onclick = () => chooser.pick();

async function onExeDrop(file: File): Promise<void> {
	reading = await readUpdater(new Uint8Array(await file.arrayBuffer()));
	if (reading.kind === "refused") return;
	for (const image of reading.images) {
		if (image.admission.kind === "admitted") void image.admission.image.entry.version;
		else void image.admission.refusal.code;
	}
}

makeOfficialButton.onclick = () => kit.makeOfficial(admittedImage);

// The keymap editor asks the kit what G1 has unlocked.
async function applyCapsToCtrl(): Promise<JobState | undefined> {
	const caps = kit.capabilities();
	if (!caps.canWrite) {
		lockedEditor(caps.blockedBy);
		return undefined;
	}
	const base: Layer = 0;
	return kit.applyKeymap({ overrides: new Map([[base, new Map([[keyId(4), usage(0xe0)]])]]), osMode: null }, "windows");
}

void [onExeDrop, applyCapsToCtrl];
