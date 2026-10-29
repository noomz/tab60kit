import { expect, test } from "bun:test";
import { startOf } from "./start";

test("a framed page never runs, whatever else holds; otherwise WebHID and a secure context decide", () => {
	expect(startOf({ framed: true, hasWebHid: true, secure: true })).toBe("framed");
	expect(startOf({ framed: true, hasWebHid: false, secure: false })).toBe("framed");
	expect(startOf({ framed: false, hasWebHid: true, secure: true })).toBe("run");
	expect(startOf({ framed: false, hasWebHid: false, secure: true })).toBe("no-webhid");
	expect(startOf({ framed: false, hasWebHid: true, secure: false })).toBe("insecure-context");
});
