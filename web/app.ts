/**
 * The page: draws viewFor(screenFor(...)) into `root` and wires its buttons to the kit. It redraws on every kit
 * state change, after a pick (the two moments the chooser's parked request can change), and after each editor edit.
 * Once a board was read, the Board, result, and Stopped screens carry the keymap editor below the flash map.
 */
import { type KeyCap, type KeyId, type KeymapDoc, type Kit, type Layer, type OsKeyMode, TAB60_KEYS, type UpdaterReading, canRemap, readUpdater, usage } from "@tab60kit/core";
import { LAYER_NAME, factoryNote, overrideRows, withOverride } from "./editor";
import { type KeyValueStore, loadKeymap, saveKeymap } from "./keymap-store";
import { type Screen, screenFor } from "./screens";
import { TARGETS, usageName } from "./usages";
import { type Action, FLASH_LEGEND, HOLD_STILL_BANNER, OS_KEY_MODE_NAME, type PageView, type StatusChip, type Tone, admittedImage, statusChips, viewFor } from "./view";
import type { Chooser } from "./webhid-port";

const EDITS_ON: readonly Screen["name"][] = ["board", "result", "stopped"];

/** Pick and Install name their row and version, so PageView carries their text. */
const LABEL: Readonly<Record<Exclude<Action, "pick" | "install">, string>> = {
	connect: "Connect",
	"deep-check": "Deep check",
	apply: "Apply",
	cancel: "Stop",
	skip: "Skip",
};

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

const panel = (tone: Tone, ...kids: Node[]) => {
	const node = element("section", `panel tone-${tone}`);
	node.append(...kids);
	return node;
};

function flashTable(rows: NonNullable<PageView["flashMap"]>): HTMLTableElement {
	const table = element("table", "flash-map");
	table.append(element("caption", undefined, "Flash map"));
	const head = table.createTHead().insertRow();
	for (const name of ["Region", "Addresses", "Finding"]) head.append(element("th", undefined, name));
	const body = table.createTBody();
	for (const row of rows) {
		const line = body.insertRow();
		line.insertCell().textContent = row.region;
		const range = line.insertCell();
		range.className = "mono";
		range.textContent = row.range;
		const finding = line.insertCell();
		finding.className = `finding tone-${row.tone}`;
		finding.textContent = row.finding;
		if (row.detail !== null) {
			const more = element("details", "detail");
			more.append(element("summary", undefined, "Details"), element("p", "mono", row.detail));
			finding.append(more);
		}
	}
	return table;
}

function legend(): HTMLUListElement {
	const list = element("ul", "legend");
	for (const item of FLASH_LEGEND) list.append(element("li", `finding tone-${item.tone}`, item.text));
	return list;
}

function select(label: string, options: readonly (readonly [string, string])[], value: string, onChange: (value: string) => void): HTMLLabelElement {
	const box = element("select");
	for (const [optionValue, text] of options) {
		const option = element("option", undefined, text);
		option.value = optionValue;
		box.append(option);
	}
	box.value = value;
	box.addEventListener("change", () => onChange(box.value));
	const chevron = element("span", "select");
	chevron.append(box);
	const wrapper = element("label", "field");
	wrapper.append(element("span", "field-label", label), chevron);
	return wrapper;
}

function button(text: string, onClick: () => void, kind: "primary" | "secondary" | "text" = "secondary", disabled = false): HTMLButtonElement {
	const node = element("button", `btn btn-${kind}`, text);
	node.type = "button";
	node.disabled = disabled;
	node.addEventListener("click", onClick);
	return node;
}

function header(chips: readonly StatusChip[]): HTMLElement {
	const bar = element("div", "bar");
	const brand = element("p", "brand");
	brand.append(element("span", "brand-name", "tab60kit"), element("span", "brand-for", "for the Vortex TAB 60"));
	const right = element("p", "chips");
	for (const chip of chips) {
		const node = element("span", `chip chip-${chip.kind}`);
		node.append(element("span", "dot"), chip.label);
		right.append(node);
	}
	bar.append(brand, right);
	const top = element("header", "top");
	top.append(bar);
	return top;
}

/** A muted outline of the board, drawn from the caps the editor uses. */
function outline(): HTMLElement {
	const board = element("div", "keyboard outline");
	board.setAttribute("aria-hidden", "true");
	for (const row of [0, 1, 2, 3, 4] as const) {
		const line = element("div", "krow");
		for (const cap of TAB60_KEYS.filter((c) => c.row === row)) {
			const key = element("span", "key");
			key.style.setProperty("--w", String(cap.width));
			line.append(key);
		}
		board.append(line);
	}
	return board;
}

/** The page frame every screen shares: the header with its chips, the hold-still banner, and `main`. */
function frame(root: HTMLElement, chips: readonly StatusChip[], holdStill: boolean, main: readonly Node[]): void {
	const nodes: Node[] = [header(chips)];
	if (holdStill) {
		const banner = element("p", "banner", HOLD_STILL_BANNER);
		banner.setAttribute("role", "alert");
		nodes.push(banner);
	}
	const body = element("main", "main");
	body.append(...main);
	nodes.push(body);
	root.replaceChildren(...nodes);
}

/** The page for a browser that cannot run the kit: no board, no buttons. */
export function mountUnsupported(root: HTMLElement, why: "no-webhid" | "insecure-context"): void {
	const view = viewFor(screenFor({ kind: "unsupported", why }), null);
	const card = panel(view.tone, element("h1", "title", view.title), ...view.lines.map((line) => element("p", "line", line)));
	card.classList.add("narrow");
	frame(root, [{ kind: "idle", label: "Not connected" }], false, [card]);
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
	let reading: UpdaterReading | null = null;
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
		install: () => {
			const image = admittedImage(reading);
			if (image !== null) run(kit.makeOfficial(image));
		},
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
		const node = button(
			cap.legend,
			() => {
				selected = cap.id;
				render();
			},
			"secondary",
			!canRemap(cap.id),
		);
		node.className = to === undefined ? "key" : "key live";
		if (to !== undefined) node.append(element("span", "key-to", ` → ${usageName(to)}`));
		node.style.setProperty("--w", String(cap.width));
		node.setAttribute("aria-pressed", String(selected === cap.id));
		return node;
	}

	function editor(): HTMLElement {
		const caps = kit.capabilities();
		const section = panel("plain", element("h2", "heading", "Keymap"));
		section.classList.add("editor");
		if (!caps.canWrite) for (const line of caps.blockedBy) section.append(element("p", "note tone-muted", line));
		const settings = element("div", "settings");
		settings.append(
			select("OS key mode", [["", "Choose the mode the board runs in"], ...MODES.map((m): [string, string] => [m, OS_KEY_MODE_NAME[m]])], mode ?? "", (value) => edit(doc, isMode(value) ? value : null)),
			select("Layer", ([0, 1, 2] as const).map((l): [string, string] => [String(l), LAYER_NAME[l]]), String(layer), (value) => {
				layer = Number(value) as Layer;
				render();
			}),
		);
		section.append(settings);
		const board = element("div", "keyboard");
		for (const row of [0, 1, 2, 3, 4] as const) {
			const line = element("div", "krow");
			for (const cap of TAB60_KEYS.filter((c) => c.row === row)) line.append(keyButton(cap));
			board.append(line);
		}
		const well = element("div", "keyboard-well");
		well.append(board);
		section.append(well);
		const cap = TAB60_KEYS.find((c) => c.id === selected);
		if (cap !== undefined) {
			const current = doc.overrides.get(layer)?.get(cap.id);
			const pick = element("div", "settings");
			pick.append(
				select(`${cap.legend} on ${LAYER_NAME[layer]} sends`, [["", `${cap.legend} (no override)`], ...TARGETS.map((t): [string, string] => [String(t.usage), t.name])], current === undefined ? "" : String(current), (value) =>
					edit(withOverride(doc, layer, cap.id, value === "" ? null : usage(Number(value)))),
				),
			);
			section.append(pick);
			const note = factoryNote(layer, cap.id);
			if (note !== null) section.append(element("p", "note tone-attention", note));
		}
		const list = element("ul", "overrides");
		for (const row of overrideRows(doc)) {
			const item = element("li", undefined);
			item.append(element("span", "mono", row.text), button("Remove", () => edit(withOverride(doc, row.layer, row.key, null)), "text"));
			list.append(item);
		}
		section.append(list.childElementCount > 0 ? list : element("p", "note", "No overrides. Pick a key to change what it sends."));
		const bar = element("div", "apply-bar");
		const words = element("div", "apply-words");
		words.append(
			element(
				"p",
				"line",
				"Apply writes to the board's memory only and saves nothing on the board. When the board loses power (USB unplugged with the batteries out), it types its saved keys again: click Apply once more. This browser keeps the keymap.",
			),
		);
		if (mode === null) words.append(element("p", "note", "Choose the OS key mode before Apply: the keys move with it."));
		if (storageProblem !== null) words.append(element("p", "note tone-attention", storageProblem));
		bar.append(button(LABEL.apply, act.apply, "primary", mode === null || !caps.canWrite), words);
		section.append(bar);
		return section;
	}

	function exePicker(): HTMLElement {
		const input = element("input", "visually-hidden");
		input.type = "file";
		input.accept = ".exe";
		input.addEventListener("change", () => {
			const file = input.files?.[0];
			if (file === undefined) return;
			void file
				.arrayBuffer()
				.then((buffer) => readUpdater(new Uint8Array(buffer)))
				.then((read) => {
					reading = read;
				})
				.finally(render);
		});
		const label = element("label", "dropzone");
		label.append(element("span", "dropzone-title", "Vendor updater"), element("span", "note", "Tab60firmwareV1.01.13.exe from vortexgear.tw. The page reads it here and uploads nothing."), element("span", "btn btn-secondary", "Choose file"), input);
		return label;
	}

	function render(): void {
		const screen = screenFor({ kind: "kit", state: kit.state, reading, keymap: doc, caps: kit.capabilities() });
		view = viewFor(screen, chooser.needsClick);
		const edits = EDITS_ON.includes(screen.name) && kit.state.board !== null;
		const card = panel(view.tone);
		if (screen.name === "connect") card.append(outline());
		card.append(element("h1", "title", view.title));
		for (const line of view.lines) card.append(element("p", "line", line));
		if (view.progress !== null) {
			const bar = element("progress", "progress");
			bar.max = view.progress.total;
			bar.value = view.progress.done;
			bar.setAttribute("aria-label", view.lines[0] ?? view.title);
			card.append(bar);
		}
		if (edits) card.append(exePicker());
		if (view.linuxRule !== null) card.append(element("pre", "code", view.linuxRule));
		let pick: HTMLButtonElement | null = null;
		if (view.actions.length > 0) {
			const bar = element("div", "actions");
			for (const action of view.actions) {
				const text = action === "pick" ? (view.pickLabel ?? "Pick") : action === "install" ? (view.installLabel ?? "Install official firmware") : LABEL[action];
				const node = button(text, act[action], action === view.primary ? "primary" : "secondary");
				if (action === "pick") {
					node.classList.add("btn-pick");
					pick = node;
				}
				bar.append(node);
			}
			card.append(bar);
		}
		const main: Node[] = [];
		if (view.flashMap === null && view.boot === null) {
			card.classList.add("narrow");
			main.push(card);
		} else {
			const aside = panel("plain", element("h2", "heading", "On the chip"));
			if (view.flashMap !== null) aside.append(flashTable(view.flashMap), legend());
			if (view.boot !== null) aside.append(element("p", `boot tone-${view.boot.tone}`, view.boot.text));
			const split = element("div", "split");
			split.append(card, aside);
			main.push(split);
		}
		if (edits) main.push(editor());
		frame(root, statusChips(kit.state, chooser.needsClick), view.holdStill, main);
		pick?.focus();
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
