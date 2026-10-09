// expect: none
// The control: legal uses of the same types compile, so each failure above comes from its injected defect.
import type { AppChip, IapChip, Observed } from "../core/chip";
import { type Admission, CATALOG } from "../core/firmware";
import { decideInApp, decideInIap } from "../core/flash";
import { keyId } from "../core/keymap";
import type { Link } from "../core/port";
import {
	type AppSession,
	type Clearance,
	type IapSession,
	type Maturity,
	SHIPPED,
	auditEgress,
	labClearance,
} from "../core/protocol";

declare const admission: Admission;
declare const appChip: AppChip;
declare const iapChip: IapChip;
declare const appSession: AppSession;
declare const iapSession: IapSession;
declare const link: Link;
declare const frame: Uint8Array;
if (admission.kind === "admitted") {
	void decideInApp(appChip, admission.image, false);
	void decideInIap(iapChip, admission.image, false);
	void admission.image.entry.version;
}
const observed: readonly Observed[] = [
	{ mode: "app", session: appSession, chip: appChip },
	{ mode: "iap", session: iapSession, chip: iapChip },
];
void iapSession.eraseWindow();
const verdict = auditEgress(frame, "readMode", { mode: "app", window: null, cursor: null, cleared: () => true });
if (verdict.ok) void link.send(verdict.frame);
const lab: Clearance = labClearance(["readMode"], "control");
const confirmed: Maturity = { level: "confirmed", by: "user", on: "2026-10-10", capture: "fixtures/u1-macos.json" };
void [observed, keyId(4), CATALOG.length, lab, SHIPPED, confirmed];
