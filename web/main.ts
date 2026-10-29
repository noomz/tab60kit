import { mountApp, mountUnsupported } from "./app";
import { startWebHid } from "./webhid-port";

const why = !("hid" in navigator) ? "no-webhid" : !isSecureContext ? "insecure-context" : null;
if (why === null) {
	// Each pick and open goes to the console, so a board run shows how a chooser closed: its path, its wait, and its row.
	const { kit, chooser } = startWebHid(navigator.hid, navigator.locks, undefined, (event) => console.debug("tab60kit", event));
	mountApp(document.body, kit, chooser);
} else {
	mountUnsupported(document.body, why);
}
