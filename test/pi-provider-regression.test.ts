import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Isolation is essential: test/setup.ts replaces Pi's converter for old unit tests.
// The child executes an ordinary TS program, not bun:test, so it runs actual Pi.
for (const api of ["openai-responses", "openai-codex-responses"]) {
	for (const capability of ["true", "false", "absent"]) {
		for (const placement of ["before", "interior", "trailing", "tools-before-results", "tools-between-results", "tools-trailing-orphan"]) {
			for (const reasoning of [false, true]) {
				test(`real Pi provider replay: ${api} capability=${capability} update=${placement} reasoning=${reasoning}`, () => {
					const result = spawnSync(process.execPath, [path.join(import.meta.dir, "helpers/pi-provider-probe.ts"), api, capability, placement, String(reasoning)], {
						encoding: "utf8", timeout: 20000,
					});
					expect({ exit: result.status, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
					expect(JSON.parse(result.stdout)).toMatchObject({ checkpoint: true, networkCalls: 0, parity: true, hook: true, strictTamperRejected: true });
				}, 25000);
			}
		}
	}
}
