import type { Clock, DevicePort, DeviceWant, InReport, Link, Mode, OutReport } from "../core/port";
import { LinkTimeout, asInReport } from "../core/port";

export const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function report(hex: string): InReport {
	if (hex.length > 128) throw new RangeError(`report of ${hex.length / 2} bytes`);
	return asInReport(fromHex(hex.padEnd(128, "0")));
}

export class ScriptedLink implements Link {
	readonly sent: Uint8Array[] = [];
	readonly calls: string[] = [];
	readonly replies: (InReport | Error)[] = [];
	closed = 0;
	readonly lost = new Promise<void>(() => undefined);

	constructor(
		readonly mode: Mode,
		replies: readonly (InReport | Error)[] = [],
		private readonly log: string[] = [],
	) {
		this.replies.push(...replies);
	}

	async send(frame: OutReport): Promise<void> {
		this.sent.push(Uint8Array.from(frame));
		this.calls.push("send");
		this.log.push(`send ${toHex(frame.subarray(0, 2))}`);
	}

	async next(timeoutMs: number): Promise<InReport> {
		this.calls.push(`next(${timeoutMs})`);
		const reply = this.replies.shift();
		if (reply === undefined) throw new LinkTimeout("scripted: no reply queued");
		if (reply instanceof Error) throw reply;
		return reply;
	}

	discardPending(): readonly InReport[] {
		this.calls.push("discardPending");
		return [];
	}

	async close(): Promise<void> {
		this.calls.push("close");
		this.closed++;
	}
}

export function scriptedClock(now: () => number = () => performance.now()): Clock {
	return { now, sleep: async () => undefined };
}

export class ScriptedPort implements DevicePort {
	readonly opens: DeviceWant[] = [];

	constructor(
		private readonly links: ScriptedLink[],
		readonly clock: Clock = scriptedClock(),
		private readonly log: string[] = [],
	) {}

	async open(want: DeviceWant, signal: AbortSignal): Promise<Link> {
		signal.throwIfAborted();
		this.opens.push(want);
		this.log.push(`open ${want.modes.join("|")}`);
		const link = this.links.shift();
		if (link === undefined) throw new Error("scripted port: no link left to open");
		return link;
	}

	exclusive<T>(job: () => Promise<T>): Promise<T> {
		return job();
	}
}
