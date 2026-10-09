// expect: TS2339
// UI code holds an image handle and cannot read its bytes: the handle carries the catalog entry and no byte field.
import type { FlashableImage } from "../core/index";

declare const image: FlashableImage;
void image.wire;
void image.versionBlock;
