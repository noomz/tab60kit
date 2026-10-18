/**
 * The page: draws viewFor(screenFor(...)) into `root` and wires its buttons to the kit. It redraws on every kit
 * state change and after a pick, the two moments the chooser's parked request can change.
 */
import type { KeymapDoc, Kit } from "@tab60kit/core";
import { screenFor } from "./screens";
import { type Action, type PageView, viewFor } from "./view";
import type { Chooser } from "./webhid-port";

const NO_KEYMAP: KeymapDoc = { overrides: new Map(), osMode: null };

const LABEL: Readonly<Record<Exclude<Action, "pick">, string>> = {
	connect: "Connect",
	"deep-check": "Deep check",
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

export function mountApp(root: HTMLElement, kit: Kit, chooser: Chooser): () => void {
	let view: PageView | null = null;
	const run = (job: Promise<unknown>) => {
		// The kit has already set the stopped state an error leads to; the page shows that, not the rejection.
		job.catch(() => undefined).finally(render);
	};
	const act: Readonly<Record<Action, () => void>> = {
		connect: () => run(kit.check("quick")),
		"deep-check": () => run(kit.check("deep")),
		pick: () => {
			chooser.pick();
			render();
		},
		cancel: () => kit.cancel(),
		// During the optional confirm pick, the kit's cancel is Skip: the job still finishes.
		skip: () => kit.cancel(),
	};

	function render(): void {
		view = viewFor(screenFor({ kind: "kit", state: kit.state, reading: null, keymap: NO_KEYMAP, caps: kit.capabilities() }), chooser.needsClick);
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
