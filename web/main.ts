import { mountApp, mountUnsupported } from "./app";
import { startWebHid } from "./webhid-port";

const why = !("hid" in navigator) ? "no-webhid" : !isSecureContext ? "insecure-context" : null;
if (why === null) {
	const { kit, chooser } = startWebHid(navigator.hid, navigator.locks);
	mountApp(document.body, kit, chooser);
} else {
	mountUnsupported(document.body, why);
}
