import { mountApp, mountFramed, mountUnsupported } from "./app";
import { startOf } from "./start";
import { startWebHid } from "./webhid-port";

const start = startOf({ framed: window.top !== window.self, hasWebHid: "hid" in navigator, secure: isSecureContext });
if (start === "framed") mountFramed(document.body, location.href);
else if (start === "run") {
	// Each pick and open goes to the console, so a board run shows how a chooser closed: its path, its wait, and its row.
	const { kit, chooser } = startWebHid(navigator.hid, navigator.locks, undefined, (event) => console.debug("tab60kit", event));
	mountApp(document.body, kit, chooser);
} else {
	mountUnsupported(document.body, start);
}
