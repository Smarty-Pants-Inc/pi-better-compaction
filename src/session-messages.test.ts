import { describe, expect, test } from "bun:test";
import { buildSessionMessages } from "./extension-runtime";

const messages = [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }] as never[];

describe("buildSessionMessages", () => {
	test("uses Pi's read-only buildSessionProjection when buildSessionContext is absent (detached extension view)", () => {
		const view = Object.freeze({ buildSessionProjection: () => Object.freeze({ entries: [], messages: Object.freeze([...messages]), thinkingLevel: "off", model: null }) });
		expect(buildSessionMessages({ sessionManager: view as never })).toEqual(messages);
	});

	test("prefers the live buildSessionContext when an older Pi passes the live manager", () => {
		const live = { buildSessionContext: () => ({ messages }), buildSessionProjection: () => { throw new Error("unused"); } };
		expect(buildSessionMessages({ sessionManager: live as never })).toBe(messages);
	});
});
