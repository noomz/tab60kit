// expect: TS2322
// A row cannot be confirmed without naming the capture that confirms it.
import type { Maturity } from "../core/protocol";

const confirmed: Maturity = { level: "confirmed", by: "user", on: "2026-10-10" };
void confirmed;
