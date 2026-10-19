// expect: TS2322
// The firmware has three key layers (sub_5E98 bounds its index at 0x2FF), so a fourth does not type-check.
import type { Layer } from "../core/keymap";

const fourth: Layer = 3;
void fourth;
