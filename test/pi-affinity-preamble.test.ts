import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Keep reason: data-safety/trust boundary; reproduces #15's merge-queue catch
// against #8742 without weakening main's original affinity regression.
for (const api of ["openai-responses", "openai-codex-responses"]) {
	for (const reasoning of [false, true]) {
		test(`real Pi affinity preamble: ${api} reasoning=${reasoning}`, () => {
			const result = spawnSync(process.execPath, [path.join(import.meta.dir, "helpers/pi-affinity-preamble-probe.ts"), api, String(reasoning)], {
				encoding: "utf8", timeout: 20000,
			});
			expect({ exit: result.status, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
			expect(JSON.parse(result.stdout)).toMatchObject({ realPiPayload: true, recoveredCleanTranscript: true, unknownInteriorBlocked: true, nativeMcpPreserved: true, retiredMcpFailClosed: true, aborts: 4, networkCalls: 0 });
		}, 25000);
	}
}
