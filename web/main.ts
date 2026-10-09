import { CATALOG } from "@tab60kit/core";

const known = CATALOG.map((entry) => `${entry.version} (${entry.layoutName})`).join(", ");

document.body.textContent =
	"hid" in navigator ? `The app arrives in plan unit U6. Official firmware in the catalog: ${known}.` : "Use Chrome or Edge.";
