/** What each page button does, DOM-free so a test can press every button a screen shows against a real kit. */
import type { KeymapDoc, Kit, OsKeyMode, UpdaterReading } from "@tab60kit/core";
import { admittedImage } from "./screens";
import type { Action } from "./view";
import type { Chooser } from "./webhid-port";

/** What the page holds besides the kit: the dropped exe, and the keymap with its OS key mode. */
export interface PageFacts {
	readonly reading: UpdaterReading | null;
	readonly doc: KeymapDoc;
	readonly mode: OsKeyMode | null;
}

/** A job's promise, for the page to redraw when it settles, or null when the button started none. */
export type Press = () => Promise<unknown> | null;

export function actionHandlers(kit: Kit, chooser: Chooser, facts: () => PageFacts): Readonly<Record<Action, Press>> {
	return {
		connect: () => kit.check("quick"),
		recheck: () => kit.check("quick"),
		"deep-check": () => kit.check("deep"),
		install: () => {
			const image = admittedImage(facts().reading);
			return image === null ? null : kit.makeOfficial(image);
		},
		apply: () => {
			const { doc, mode } = facts();
			return mode === null ? null : kit.applyKeymap(doc, mode);
		},
		pick: () => {
			chooser.pick();
			return null;
		},
		cancel: () => {
			kit.cancel();
			return null;
		},
		// During the optional confirm pick, the kit's cancel is Skip: the job still finishes.
		skip: () => {
			kit.cancel();
			return null;
		},
	};
}
