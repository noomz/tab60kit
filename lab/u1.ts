/**
 * Plan unit U1: the first output reports tab60kit sends to this board. Not shipped. It lives outside both package
 * entries, and probes/boundaries.ts keeps web/ from importing it or the core internals it uses.
 *
 * Precondition, held by labClearance and by review: the user reviewed the seven rows below and a commit moved them
 * to "reviewed". The kit then sends exactly these commands, whatever any code path asks for; the egress audit refuses
 * the rest. The transcript this page saves is the capture that moves the rows to "confirmed".
 */
import { type Transcript, type TranscriptEntry, recording } from "../testing/transcript";
import { labClearance } from "../core/protocol";
import { startWebHid } from "../web/webhid-port";

export function startU1(hid: HID, locks: LockManager) {
	const entries: TranscriptEntry[] = [];
	const clearance = labClearance(
		["readMode", "readBlInfo", "readFwInfo", "readVersionPage", "sum", "resetToIap", "resetToApp"],
		"U1: bootloader round trip and read-only deep check",
	);
	const { kit, chooser } = startWebHid(hid, locks, {
		clearance,
		wrap: (link) => recording(link, (entry) => entries.push(entry)),
	});
	const transcript = (environment: Readonly<Record<string, string>>): Transcript => ({
		format: "tab60kit-transcript/1",
		recordedAt: new Date().toISOString(),
		environment,
		entries: [...entries],
	});
	return { deepCheck: () => kit.check("deep"), chooser, transcript };
}
