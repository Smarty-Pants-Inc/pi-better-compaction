// No bun:test preload: exercise the published bundled loader, not its unit mocks.
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
try {
	const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
	const installed = path.join(root, "extension");
	await mkdir(installed);
	await writeFile(path.join(installed, "package.json"), JSON.stringify(manifest));
	for (const file of manifest.files) await cp(path.join(repo, file), path.join(installed, file), { recursive: true });
	// Copy the published CLI package alone, not its physically installed peers.
	// Its bundled virtual modules must be sufficient for extension initialization.
	const runtime = path.join(root, "runtime");
	await cp(path.join(repo, "node_modules/@earendil-works/pi-coding-agent"), runtime, {
		recursive: true, dereference: true, filter: source => path.basename(source) !== "node_modules",
	});
	// jiti is an external CLI dependency, not a host-provided Pi peer.
	await mkdir(path.join(runtime, "node_modules"));
	await cp(path.join(repo, "node_modules/jiti"), path.join(runtime, "node_modules/jiti"), { recursive: true, dereference: true });
	for (const peer of Object.keys(manifest.peerDependencies)) {
		assert.equal(await stat(path.join(runtime, "node_modules", peer)).then(() => true, () => false), false);
	}
	for (const dir of [root, installed]) {
		assert.equal(await stat(path.join(dir, "node_modules")).then(() => true, () => false), false);
	}
	const cli = path.join(runtime, "dist/bundle/cli.js");
	const home = path.join(root, "home");
	await mkdir(home);
	const env = { PATH: process.env.PATH!, HOME: home, TMPDIR: root, PI_OFFLINE: "1" };
	const version = spawnSync("node", [cli, "--version"], { cwd: root, env, encoding: "utf8", timeout: 20000 });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), "1.0.0");
	const run = (extension: string) => spawnSync("node", [cli, "--mode", "rpc", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--no-tools", "--no-session", "-e", extension], {
		cwd: root, env, input: '{"id":"load-probe","type":"get_state"}\n', encoding: "utf8", timeout: 20000,
	});
	await writeFile(path.join(root, "control.ts"), 'import { getCurrentSystemPrompt } from "@earendil-works/pi-ai"; export default function () { if (typeof getCurrentSystemPrompt !== "function") throw new Error("Missing root export"); }\n');
	await writeFile(path.join(root, "subpath.ts"), 'import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages"; export default function () { if (typeof transformMessages !== "function") throw new Error("Missing transform"); }\n');
	const control = run(path.join(root, "control.ts"));
	const subpath = run(path.join(root, "subpath.ts"));
	const extension = run(installed);
	const summary = { version: version.stdout.trim(), noLocalPeers: true, isolatedHome: true, offline: true,
		control: { exit: control.status, stdout: control.stdout, stderr: control.stderr },
		subpath: { exit: subpath.status, stdout: subpath.stdout, stderr: subpath.stderr },
		extension: { exit: extension.status, stdout: extension.stdout, stderr: extension.stderr } };
	if (process.env.PI_INSTALLED_LOAD_EVIDENCE) await writeFile(process.env.PI_INSTALLED_LOAD_EVIDENCE, JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
	const stateOK = (stdout: string) => stdout.split("\n").filter(Boolean).map(line => JSON.parse(line)).some(response => response.id === "load-probe" && response.command === "get_state" && response.success === true);
	assert.equal(control.status, 0, control.stderr);
	assert.ok(stateOK(control.stdout), "root-only control must return RPC state");
	assert.equal(subpath.status, 1, "unsupported virtual subpath must remain unavailable in this fixture");
	assert.ok(subpath.stderr.includes("Cannot find module '@earendil-works/pi-ai/api/transform-messages'"), subpath.stderr);
	assert.equal(extension.status, 0, extension.stderr);
	assert.ok(stateOK(extension.stdout), "installed extension must return RPC state");
} finally {
	await rm(root, { recursive: true, force: true });
}
