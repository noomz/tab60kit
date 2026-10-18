import { mountApp } from "./app";
import { screenFor } from "./screens";
import { viewFor } from "./view";
import { startWebHid } from "./webhid-port";

const why = !("hid" in navigator) ? "no-webhid" : !isSecureContext ? "insecure-context" : null;
if (why === null) {
	const { kit, chooser } = startWebHid(navigator.hid, navigator.locks);
	mountApp(document.body, kit, chooser);
} else {
	const view = viewFor(screenFor({ kind: "unsupported", why }), null);
	const title = document.createElement("h1");
	title.textContent = view.title;
	const line = document.createElement("p");
	line.textContent = view.lines.join(" ");
	document.body.replaceChildren(title, line);
}
