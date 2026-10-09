// expect: TS2322
// A span cannot be built from a raw number, so no code outside flashmap.ts can name an address.
import type { Span } from "../core/flashmap";

const bootloader: Span = { offset: 0x0, length: 0x3000 };
void bootloader;
