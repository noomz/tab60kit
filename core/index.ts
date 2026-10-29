/**
 * The public entry for UI code. Shells also import ./port. package.json "exports" exposes only these two,
 * so protocol.ts, flashmap.ts, and the sessions are unreachable from outside the package.
 *
 * Functions: createKit, readUpdater, report, bootTarget, udevRules, keyId, usage, canRemap, factoryKey, fnCode, and the keymap document parse
 * and serialize pair. Everything else here is a type the UI renders.
 *
 * Left out on purpose, and kept out by probes/internals-not-public.ts: `imageBytes` (a FlashableImage is a handle
 * whose bytes UI code never reads), `labClearance` (only lab pages widen G1), and `auditEgress` (the only maker of
 * the OutReport that Link.send takes).
 */
export { type Kit, createKit } from "./kit";
export {
	type Admission,
	type AdmissionRefusal,
	CATALOG,
	type CatalogEntry,
	type FlashableImage,
	OPEN_FIRMWARE_PREREQUISITES,
	type OpenFirmwarePrerequisite,
	type UpdaterReading,
	readUpdater,
} from "./firmware";
export type { UpdaterRefusal } from "./updater";
export type { Activity, JobKind, JobResult, JobState, StopReason } from "./job";
export {
	type BootTarget,
	type ChipReport,
	type ChipState,
	type Finding,
	type ImageCheck,
	type PageState,
	bootTarget,
	report,
} from "./chip";
export type { LayoutRefusal } from "./flashmap";
export { TAB60, udevRules } from "./device";
export {
	type ConfigCapabilities,
	type KeyCap,
	type KeyId,
	type KeymapDoc,
	type KeymapProblem,
	LAYER_KEY_MARKERS,
	type Layer,
	type OsKeyMode,
	type OsMode,
	type StoreReading,
	TAB60_KEYS,
	type Usage,
	canRemap,
	type FactoryKey,
	factoryKey,
	fnCode,
	keyId,
	parseKeymapDoc,
	serializeKeymapDoc,
	usage,
} from "./keymap";
export type { DeviceWant, WantReason } from "./port";
export type { OverrideEntry } from "./protocol";
