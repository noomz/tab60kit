// expect: TS2345
// The update-mode policy cannot be asked about a normal-mode observation.
import type { AppChip } from "../core/chip";
import type { FlashableImage } from "../core/firmware";
import { decideInIap } from "../core/flash";

declare const chip: AppChip;
declare const target: FlashableImage;
void decideInIap(chip, target, false);
