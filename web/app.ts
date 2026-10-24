/**
 * The page: draws viewFor(screenFor(...)) into `root` and wires its buttons to the kit. It redraws on every kit
 * state change, after a pick (the two moments the chooser's parked request can change), and after each editor edit.
 * Once a board was read, the Board, result, and Stopped screens carry the keymap editor below the flash map.
 */
import { type KeyCap, type KeyId, type KeymapDoc, type Kit, type Layer, type OsKeyMode, TAB60_KEYS, canRemap, usage } from "@tab60kit/core";
import { LAYER_NAME, overrideRows, withOverride } from "./editor";
import { type KeyValueStore, loadKeymap, saveKeymap } from "./keymap-store";
import { type Screen, screenFor } from "./screens";
import { TARGETS, usageName } from "./usages";
import { type Action, OS_KEY_MODE_NAME, type PageView, viewFor } from "./view";
import type { Chooser } from "./webhid-port";

const EDITS_ON: readonly Screen["name"][] = ["board", "result", "stopped"];
const KEY_UNIT_EM = 3;

const LABEL: Readonly<Record<Exclude<Action, "pick">, string>> = {
	connect: "Connect",
	"deep-check": "Deep check",
	apply: "Apply",
	cancel: "Stop",
	skip: "Skip",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	return node;
}

function flashTable(rows: NonNullable<PageView["flashMap"]>): HTMLTableElement {
	const table = element("table");
	table.append(element("caption", "Flash map"));
	const head = table.createTHead().insertRow();
	for (const name of ["Region", "Addresses", "Finding"]) head.append(element("th", name));
	const body = table.createTBody();
	for (const row of rows) {
		const line = body.insertRow();
		line.insertCell().textContent = row.region;
		line.insertCell().textContent = row.range;
		line.insertCell().textContent = row.finding;
	}
	return table;
}

function select(label: string, options: readonly (readonly [string, string])[], value: string, onChange: (value: string) => void): HTMLLabelElement {
	const box = element("select");
	for (const [optionValue, text] of options) {
		const option = element("option", text);
		option.value = optionValue;
		box.append(option);
	}
	box.value = value;
	box.addEventListener("change", () => onChange(box.value));
	const wrapper = element("label", `${label} `);
	wrapper.append(box);
	return wrapper;
}

function button(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
	const node = element("button", text);
	node.type = "button";
	node.disabled = disabled;
	node.addEventListener("click", onClick);
	return node;
}

const MODES = Object.keys(OS_KEY_MODE_NAME) as OsKeyMode[];
const isMode = (value: string): value is OsKeyMode => (MODES as readonly string[]).includes(value);

/** `storage` defaults to localStorage, read lazily: touching it throws when the browser blocks site data. */
export function mountApp(root: HTMLElement, kit: Kit, chooser: Chooser, storage: () => KeyValueStore = () => localStorage): () => void {
	let view: PageView | null = null;
	const stored = loadKeymap(storage);
	let doc: KeymapDoc = stored.doc;
	let mode: OsKeyMode | null = stored.mode;
	let storageProblem = stored.problem;
	let layer: Layer = 0;
	let selected: KeyId | null = null;
	const edit = (next: KeymapDoc, nextMode: OsKeyMode | null = mode) => {
		doc = next;
		mode = nextMode;
		storageProblem = saveKeymap(storage, doc, mode);
		render();
	};
	const run = (job: Promise<unknown>) => {
		// The kit has already set the stopped state an error leads to; the page shows that, not the rejection.
		job.catch(() => undefined).finally(render);
	};
	const act: Readonly<Record<Action, () => void>> = {
		connect: () => run(kit.check("quick")),
		"deep-check": () => run(kit.check("deep")),
		apply: () => {
			if (mode !== null) run(kit.applyKeymap(doc, mode));
		},
		pick: () => {
			chooser.pick();
			render();
		},
		cancel: () => kit.cancel(),
		// During the optional confirm pick, the kit's cancel is Skip: the job still finishes.
		skip: () => kit.cancel(),
	};

	function keyButton(cap: KeyCap): HTMLButtonElement {
		const to = doc.overrides.get(layer)?.get(cap.id);
		const node = button(to === undefined ? cap.legend : `${cap.legend} → ${usageName(to)}`, () => {
			selected = cap.id;
			render();
		}, !canRemap(cap.id));
		node.style.width = `${cap.width * KEY_UNIT_EM}em`;
		node.setAttribute("aria-pressed", String(selected === cap.id));
		return node;
	}

	function editor(): HTMLElement {
		const caps = kit.capabilities();
		const section = element("section");
		section.append(element("h2", "Keymap"));
		for (const line of caps.blockedBy) section.append(element("p", line));
		const settings = element("p");
		settings.append(
			select("OS key mode", [["", "Choose the mode the board runs in"], ...MODES.map((m): [string, string] => [m, OS_KEY_MODE_NAME[m]])], mode ?? "", (value) => edit(doc, isMode(value) ? value : null)),
			" ",
			select("Layer", ([0, 1, 2] as const).map((l): [string, string] => [String(l), LAYER_NAME[l]]), String(layer), (value) => {
				layer = Number(value) as Layer;
				render();
			}),
		);
		section.append(settings);
		for (const row of [0, 1, 2, 3, 4] as const) {
			const line = element("div");
			for (const cap of TAB60_KEYS.filter((c) => c.row === row)) line.append(keyButton(cap));
			section.append(line);
		}
		const cap = TAB60_KEYS.find((c) => c.id === selected);
		if (cap !== undefined) {
			const current = doc.overrides.get(layer)?.get(cap.id);
			const pick = element("p");
			pick.append(
				select(`${cap.legend} on ${LAYER_NAME[layer]} sends`, [["", `${cap.legend} (no override)`], ...TARGETS.map((t): [string, string] => [String(t.usage), t.name])], current === undefined ? "" : String(current), (value) =>
					edit(withOverride(doc, layer, cap.id, value === "" ? null : usage(Number(value)))),
				),
			);
			section.append(pick);
		}
		const list = element("ul");
		for (const row of overrideRows(doc)) {
			const item = element("li", `${row.text} `);
			item.append(button("Remove", () => edit(withOverride(doc, row.layer, row.key, null))));
			list.append(item);
		}
		section.append(list.childElementCount > 0 ? list : element("p", "No overrides. Pick a key to change what it sends."));
		const bar = element("p");
		bar.append(button(LABEL.apply, act.apply, mode === null || !caps.canWrite));
		section.append(bar);
		section.append(
			element(
				"p",
				"Apply writes to the board's memory only and saves nothing on the board. When the board loses power (USB unplugged with the batteries out), it types its saved keys again: click Apply once more. This browser keeps the keymap.",
			),
		);
		if (mode === null) section.append(element("p", "Choose the OS key mode before Apply: the keys move with it."));
		if (storageProblem !== null) section.append(element("p", storageProblem));
		return section;
	}

	function render(): void {
		const screen = screenFor({ kind: "kit", state: kit.state, reading: null, keymap: doc, caps: kit.capabilities() });
		view = viewFor(screen, chooser.needsClick);
		const nodes: Node[] = [element("h1", view.title)];
		for (const line of view.lines) nodes.push(element("p", line));
		if (view.linuxRule !== null) nodes.push(element("pre", view.linuxRule));
		if (view.actions.length > 0) {
			const bar = element("p");
			for (const action of view.actions) {
				const button = element("button", action === "pick" ? (view.pickLabel ?? "Pick") : LABEL[action]);
				button.type = "button";
				button.addEventListener("click", act[action]);
				bar.append(button, " ");
			}
			nodes.push(bar);
		}
		if (view.flashMap !== null) nodes.push(flashTable(view.flashMap));
		if (view.boot !== null) nodes.push(element("p", view.boot));
		if (EDITS_ON.includes(screen.name) && kit.state.board !== null) nodes.push(editor());
		root.replaceChildren(...nodes);
	}

	const holdStill = (event: BeforeUnloadEvent) => {
		if (view?.holdStill) event.preventDefault();
	};
	addEventListener("beforeunload", holdStill);
	const unsubscribe = kit.subscribe(render);
	const unsubscribePick = chooser.subscribe(render);
	render();
	return () => {
		unsubscribe();
		unsubscribePick();
		removeEventListener("beforeunload", holdStill);
	};
}
