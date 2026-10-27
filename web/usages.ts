/**
 * The keyboard-page usages the editor offers as targets, with the KeyboardEvent `code` a browser reports for each
 * (UI Events KeyboardEvent code values). The lab keylog steps compare against `code`.
 */
import { type Usage, usage } from "@tab60kit/core";

export interface Target {
	readonly usage: Usage;
	readonly name: string;
	readonly code: string;
}

const letters = Array.from({ length: 26 }, (_, i): [number, string, string] => {
	const letter = String.fromCharCode(0x41 + i);
	return [0x04 + i, letter, `Key${letter}`];
});
const digits = Array.from({ length: 10 }, (_, i): [number, string, string] => {
	const digit = String((i + 1) % 10);
	return [0x1e + i, digit, `Digit${digit}`];
});
const functionKeys = (from: number, first: number, count: number) => Array.from({ length: count }, (_, i): [number, string, string] => [from + i, `F${first + i}`, `F${first + i}`]);
const numpad = Array.from({ length: 10 }, (_, i): [number, string, string] => [0x59 + i, `Numpad ${(i + 1) % 10}`, `Numpad${(i + 1) % 10}`]);

export const TARGETS: readonly Target[] = (
	[
		...letters,
		...digits,
		[0x28, "Enter", "Enter"],
		[0x29, "Esc", "Escape"],
		[0x2a, "Backspace", "Backspace"],
		[0x2b, "Tab", "Tab"],
		[0x2c, "Space", "Space"],
		[0x2d, "-", "Minus"],
		[0x2e, "=", "Equal"],
		[0x2f, "[", "BracketLeft"],
		[0x30, "]", "BracketRight"],
		[0x31, "\\", "Backslash"],
		[0x33, ";", "Semicolon"],
		[0x34, "'", "Quote"],
		[0x35, "Grave", "Backquote"],
		[0x36, ",", "Comma"],
		[0x37, ".", "Period"],
		[0x38, "/", "Slash"],
		[0x39, "Caps Lock", "CapsLock"],
		...functionKeys(0x3a, 1, 12),
		[0x46, "Print Screen", "PrintScreen"],
		[0x47, "Scroll Lock", "ScrollLock"],
		[0x48, "Pause", "Pause"],
		[0x49, "Insert", "Insert"],
		[0x4a, "Home", "Home"],
		[0x4b, "Page Up", "PageUp"],
		[0x4c, "Delete", "Delete"],
		[0x4d, "End", "End"],
		[0x4e, "Page Down", "PageDown"],
		[0x4f, "Right", "ArrowRight"],
		[0x50, "Left", "ArrowLeft"],
		[0x51, "Down", "ArrowDown"],
		[0x52, "Up", "ArrowUp"],
		[0x53, "Num Lock", "NumLock"],
		[0x54, "Numpad /", "NumpadDivide"],
		[0x55, "Numpad *", "NumpadMultiply"],
		[0x56, "Numpad -", "NumpadSubtract"],
		[0x57, "Numpad +", "NumpadAdd"],
		[0x58, "Numpad Enter", "NumpadEnter"],
		...numpad,
		[0x63, "Numpad .", "NumpadDecimal"],
		[0x64, "ISO \\", "IntlBackslash"],
		[0x65, "Menu", "ContextMenu"],
		...functionKeys(0x68, 13, 12),
		[0xe0, "Left Ctrl", "ControlLeft"],
		[0xe1, "Left Shift", "ShiftLeft"],
		[0xe2, "Left Alt", "AltLeft"],
		[0xe3, "Left GUI", "MetaLeft"],
		[0xe4, "Right Ctrl", "ControlRight"],
		[0xe5, "Right Shift", "ShiftRight"],
		[0xe6, "Right Alt", "AltRight"],
		[0xe7, "Right GUI", "MetaRight"],
	] as const
).map(([n, name, code]) => ({ usage: usage(n), name, code }));

const BY_USAGE: ReadonlyMap<number, Target> = new Map(TARGETS.map((target) => [target.usage, target]));

/** The target's name, or the usage in hex for one this table does not list (a stored document may hold any). */
export const usageName = (u: Usage): string => BY_USAGE.get(u)?.name ?? `usage 0x${u.toString(16).padStart(2, "0")}`;

export const targetOf = (u: Usage): Target | undefined => BY_USAGE.get(u);
