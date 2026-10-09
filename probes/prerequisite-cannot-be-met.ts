// expect: TS2322
// Open firmware stays blocked: marking a prerequisite met is a type change, not a data edit.
import type { OpenFirmwarePrerequisite } from "../core/firmware";

const swd: OpenFirmwarePrerequisite = { id: "swd-probe-and-recovery-drill", met: true, why: "probe bought" };
void swd;
