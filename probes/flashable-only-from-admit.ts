// expect: TS2741
// Only admit() can build a FlashableImage. A literal with the right fields still lacks the brand.
import { CATALOG, type FlashableImage } from "../core/firmware";

const entry = CATALOG[0];
if (entry) {
	const forged: FlashableImage = { entry };
	void forged;
}
