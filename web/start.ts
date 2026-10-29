/**
 * How the page starts, decided before any UI is wired. A framed page never starts: a static host such as GitHub Pages
 * cannot send `frame-ancestors`, and a meta CSP cannot carry it, so another site could frame this page and trick a
 * click into a WebHID chooser. docs/development.md "Hosting" has the rest.
 */
export type Start = "run" | "framed" | "no-webhid" | "insecure-context";

export interface StartEnv {
	readonly framed: boolean;
	readonly hasWebHid: boolean;
	readonly secure: boolean;
}

export function startOf({ framed, hasWebHid, secure }: StartEnv): Start {
	if (framed) return "framed";
	if (!hasWebHid) return "no-webhid";
	return secure ? "run" : "insecure-context";
}
