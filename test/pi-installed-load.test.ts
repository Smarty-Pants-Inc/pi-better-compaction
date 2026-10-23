import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

test.skipIf(process.platform === "win32")("published Pi 1.0 bundled CLI loads installed package with no local host peers", () => {
	const result = spawnSync(process.execPath, [path.join(import.meta.dir, "helpers/pi-installed-load.ts")], {
		encoding: "utf8", timeout: 70000,
	});
	expect({ exit: result.status, stderr: result.stderr, stdout: result.stdout }).toMatchObject({ exit: 0, stderr: "" });
	expect(JSON.parse(result.stdout)).toMatchObject({ version: "1.0.0", noLocalPeers: true, isolatedHome: true, offline: true, control: { exit: 0 }, subpath: { exit: 1 }, extension: { exit: 0 } });
}, 75000);
