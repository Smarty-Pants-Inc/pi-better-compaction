import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

// No model credentials: real bundled CLI, PTY and built-in MCP; synthetic local
// HTTP responses stop the evidence at the network boundary, not model behavior.
for (const capability of ["true", "absent"]) {
	test.skipIf(process.platform !== "linux")(`Pi 1.0 CLI boundary: MCP changes, two native compactions and resume (${capability})`, () => {
		const result = spawnSync(process.execPath, [path.join(import.meta.dir, "helpers/pi-cli-boundary.ts"), capability], {
			encoding: "utf8", timeout: 120000,
		});
		expect({ exit: result.status, stderr: result.stderr }).toEqual({ exit: 0, stderr: "" });
		expect(JSON.parse(result.stdout)).toMatchObject({ version: "1.0.0", realPTY: true, compactions: 2, checkpointReplay: true, changedMcpReplay: true, secondCompactionReplay: true, resumeReplay: true, cliExits: [0, 0], modelBacked: false });
	}, 125000);
}
