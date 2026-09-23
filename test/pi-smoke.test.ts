import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";

describe("pi smoke", () => {
	// Needs an installed pi with a working model, so hosted CI skips it.
	test.skipIf(Boolean(process.env.CI))(
		"loads from the local package path",
		() => {
			const packageDir = path.resolve(import.meta.dir, "..");
			const result = spawnSync(
				"pi",
				[
					"--no-session",
					"--offline",
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"-e",
					packageDir,
					"-p",
					"Reply with the single word OK.",
				],
				{ encoding: "utf8" },
			);

			expect(result.status).toBe(0);
			expect(result.stdout.trim()).toBe("OK");
		},
		30000,
	);
});
