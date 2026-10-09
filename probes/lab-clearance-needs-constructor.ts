// expect: TS2322
// A lab clearance cannot be written as a literal, so a shipped page cannot widen G1 without labClearance(),
// which neither package entry exports.
import type { Clearance } from "../core/port";

const widened: Clearance = { kind: "lab", only: ["erase", "write"], purpose: "ship it" };
void widened;
