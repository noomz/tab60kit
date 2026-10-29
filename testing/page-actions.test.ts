import { expect, test } from "bun:test";
import { actionHandlers } from "../web/actions";
import { EMPTY_KEYMAP } from "../web/keymap-store";
import { screenFor } from "../web/screens";
import { type Action, viewFor } from "../web/view";
import { startWebHid } from "../web/webhid-port";
import { TARGET } from "./fake-run";
import { FakeTab60 } from "./fake-tab60";
import { FakeHid, FakeLocks } from "./fake-webhid";

/** A shipped kit on the fake board. `confirm` false makes the test Skip the optional confirm pick, as a user may. */
function page(confirm = true) {
	const board = new FakeTab60({ starting: "official-image", target: TARGET });
	const hid = new FakeHid(board, { rowAppearsInOpenChooser: ["app", "iap"], isActive: () => true });
	const { kit, chooser } = startWebHid(hid, new FakeLocks());
	const user = setInterval(() => {
		if (!confirm && kit.state.kind === "awaiting-device" && kit.state.want.reason === "confirm-normal-mode") kit.cancel();
		else if (chooser.needsClick !== null) chooser.pick();
	}, 1);
	const shown = () => viewFor(screenFor({ kind: "kit", state: kit.state, reading: null, keymap: EMPTY_KEYMAP, caps: kit.capabilities() }), chooser.needsClick).actions;
	const press = actionHandlers(kit, chooser, () => ({ reading: null, doc: EMPTY_KEYMAP, mode: null }));
	return { kit, shown, press, stop: () => clearInterval(user) };
}

const JOB: Partial<Record<Action, string>> = { connect: "quick-check", recheck: "quick-check", "deep-check": "deep-check" };

for (const confirm of [true, false]) {
	test(`after Deep check (confirm pick ${confirm ? "done" : "skipped"}), every job button the screen shows starts its job and finishes`, async () => {
		const { kit, shown, press, stop } = page(confirm);
		try {
			await kit.check("quick");
			await kit.check("deep");
			expect(kit.state).toMatchObject({ kind: "finished", result: { kind: "checked", depth: "deep" } });
			const actions = shown();
			expect(actions).toEqual(["recheck", "deep-check"]);
			for (const action of actions) {
				const job = press[action]();
				expect(job).not.toBeNull();
				await job;
				expect(kit.state).toMatchObject({ kind: "finished", job: JOB[action] });
			}
		} finally {
			stop();
		}
	});
}

test("after a skipped confirm the state says the mode is not confirmed; after a done confirm it says normal mode", async () => {
	for (const [confirm, at] of [[true, "app"], [false, null]] as const) {
		const { kit, stop } = page(confirm);
		try {
			await kit.check("quick");
			await kit.check("deep");
			expect(kit.state).toMatchObject({ kind: "finished", at });
		} finally {
			stop();
		}
	}
});
