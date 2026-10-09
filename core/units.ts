/**
 * Nominal types over primitives. Each brand names its only constructor in its doc comment.
 * Nothing else may produce the branded value, so a function that takes one trusts it without re-checking.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Absolute MCU flash address. Constructed only in flashmap.ts. */
export type FlashAddr = Brand<number, "FlashAddr">;

/** Wrapping 32-bit sum of an image's little-endian words in wire form. From `sum32()` in firmware.ts or a SUM reply. */
export type Sum32 = Brand<number, "Sum32">;

/** zlib CRC-32 of an image in wire form. From `crc32()` in firmware.ts or a CRC reply. */
export type Crc32 = Brand<number, "Crc32">;

/** Lowercase hex SHA-256. From `sha256()` in firmware.ts or `sha256Literal()` for catalog constants. */
export type Sha256 = Brand<string, "Sha256">;

/** Which firmware answers on the vendor interface. The USB product ID decides it (device.ts `modeOf`). */
export type Mode = "app" | "iap";

/** Validates a catalog constant at module load. The one sanctioned cast for this brand. */
export function sha256Literal(hex: string): Sha256 {
	if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a sha256: ${hex}`);
	return hex as Sha256;
}

/** Validates a catalog constant at module load. */
export function sum32Literal(n: number): Sum32 {
	if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`not a u32: ${n}`);
	return n as Sum32;
}

/** Validates a catalog constant at module load. */
export function crc32Literal(n: number): Crc32 {
	if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) throw new Error(`not a u32: ${n}`);
	return n as Crc32;
}

/** Marks a sketched body. Each call site is work that a unit in docs/units.md schedules. */
export function notImplemented(what: string): never {
	throw new Error(`not implemented: ${what}`);
}
