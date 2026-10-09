// expect: TS2322
// Key indices are checked once, in keyId().
import type { KeyId } from "../core/keymap";

const caps: KeyId = 4;
void caps;
