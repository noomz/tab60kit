// expect: TS2322
// An observation pairs a session with a chip of the same mode, so an update-mode step cannot get a normal-mode session.
import type { AppChip, Observed } from "../core/chip";
import type { IapSession } from "../core/protocol";

declare const session: IapSession;
declare const chip: AppChip;
const observed: Observed = { mode: "app", session, chip };
void observed;
