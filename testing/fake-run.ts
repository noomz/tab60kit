import { type ProbeSeries, type U1Context, u1Clearance, u1Connect, u1DeepCheck } from "../lab/u1-job";
import { startWebHidLab } from "../web/webhid-port";
import { FakeTab60, type FakeOptions } from "./fake-tab60";
import { FakeHid, type FakeHidOptions, FakeLocks } from "./fake-webhid";
import { type Transcript, type TranscriptEntry, recording } from "./transcript";

export const TARGET = { imageBytes: 34_268, wireSum32: 0xf3d3dbd2 };

const FAST: ProbeSeries = { probes: 30, everyMs: 1 };

export interface FakeRunOptions {
	readonly board?: Partial<FakeOptions>;
	readonly hid?: Partial<FakeHidOptions>;
	readonly series?: ProbeSeries;
	readonly between?: (board: FakeTab60, hid: FakeHid) => void;
	readonly autoPick?: boolean;
}

export async function recordFakeRun(options: FakeRunOptions = {}): Promise<{ readonly transcript: Transcript; readonly log: string[]; readonly board: FakeTab60 }> {
	const board = new FakeTab60({ starting: "official-image", target: TARGET, ...options.board });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: true, isActive: () => true, ...options.hid });
	const entries: TranscriptEntry[] = [];
	const now = () => performance.now();
	const { port, chooser } = startWebHidLab(hid, new FakeLocks(), {
		wrap: (link) => recording(link, (entry) => entries.push(entry), now),
		onEvent: (event) => entries.push({ t: now(), ...event }),
	});
	const clicker = options.autoPick ? setInterval(() => chooser.needsClick?.modes.includes(hid.device.mode) && chooser.pick(), 1) : null;
	const log: string[] = [];
	const ctx: U1Context = { port, clearance: u1Clearance(), signal: new AbortController().signal, log: (line) => log.push(line), series: options.series ?? FAST };
	try {
		const connected = await port.exclusive(() => u1Connect(ctx));
		if (connected.kind !== "connected") throw new Error(`connect refused: ${connected.refused.refusal.code}`);
		options.between?.(board, hid);
		const end = await port.exclusive(() => u1DeepCheck(connected.session, ctx));
		if (end.kind !== "done") throw new Error(`deep check refused: ${end.refused.refusal.code}`);
		log.push(`end: boot target ${end.bootTarget}, back ${end.back === null ? "skipped" : "refusal" in end.back ? end.back.refusal.code : end.back.mode}`);
		if (end.back !== null && !("refusal" in end.back)) await end.back.close();
	} finally {
		if (clicker !== null) clearInterval(clicker);
	}
	return {
		transcript: { format: "tab60kit-transcript/1", recordedAt: new Date().toISOString(), environment: { tool: "test", fake: "plain" }, entries },
		log,
		board,
	};
}

