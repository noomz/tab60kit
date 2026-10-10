import { blInfoBlock, syntheticVersionBlock } from "./fake-tab60";

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The READ BL INFO payload: the 52-byte struct, then the 8 zero bytes the app appends (R4 0x7650). */
export const BL_INFO_HEX = toHex(blInfoBlock()) + "00".repeat(8);

export const SYNTHETIC_VERSION_PAGE_HEX = toHex(syntheticVersionBlock());
