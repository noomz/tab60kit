/**
 * Builds CATALOG entries from a vendor updater the reviewer downloaded from vortexgear.tw. Prints TypeScript to
 * paste into core/firmware.ts. The reviewer fills in `oracle` from an independent source (pok3rtool's extract test,
 * the RE repo, or a second download) before the entry lands.
 *
 * This is how a new vendor release becomes flashable: a reviewed diff to one list, never a runtime setting.
 * Run with: node tools/catalog-entry.ts <updater.exe> <download-url>
 */
import { type CatalogEntry, readUpdater } from "../core/firmware";
import type { UpdaterRefusal } from "../core/updater";
import { notImplemented } from "../core/units";

/**
 * TODO: reading = readUpdater(exe); refused -> return the refusal.
 * Per image: id from product, version, and layout; sha256 of exe and image; wire sum and CRC-32; version block hash.
 * The result omits `oracle`, so the pasted literal fails to typecheck as a CatalogEntry until a reviewer adds one.
 */
export async function catalogEntries(
	exe: Uint8Array,
	url: string,
): Promise<readonly Omit<CatalogEntry, "oracle">[] | UpdaterRefusal> {
	return notImplemented(`catalogEntries(${exe.length} bytes from ${url}) via ${readUpdater.name}`);
}
