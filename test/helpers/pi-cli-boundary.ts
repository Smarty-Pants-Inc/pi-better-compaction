import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageDir = process.env.PI_COMPACTION_PACKAGE ?? repo;
const capability = process.argv[2] ?? "absent";
const root = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "pbc-cli-"));
const node = spawnSync("which", ["node"], { encoding: "utf8" }).stdout.trim();
const cli = path.join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const eventsFile = path.join(root, "events.jsonl");
const wireFile = path.join(root, "wire.jsonl");
let current: ReturnType<typeof spawn> | undefined;
let exited: Promise<number | null> | undefined;
let fatal: unknown;
let requestIndex = 0;
let compactCount = 0;
const wire: any[] = [];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const server = createServer(async (req, res) => {
	try {
		assert.equal(req.url, "/v1/responses");
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const payload = JSON.parse(raw);
		const compact = payload.input.some((item: any) => item.type === "compaction_trigger");
		const index = ++requestIndex;
		wire.push({ index, compact, payload });
		// Deliberately save only the JSON body: never save HTTP headers/credentials.
		await appendFile(wireFile, JSON.stringify({ index, compact, payload }) + "\n");
		res.writeHead(200, { "content-type": "text/event-stream" });
		const emit = (event: any) => res.write(`data: ${JSON.stringify(event)}\n\n`);
		const usage = { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } };
		if (compact) {
			const item = { type: "compaction", id: `cmp_${++compactCount}`, encrypted_content: `SYNTHETIC_ENCRYPTED_CHECKPOINT_${compactCount}` };
			emit({ type: "response.output_item.done", output_index: 0, item });
			emit({ type: "response.completed", response: { id: `resp_compact_${compactCount}`, created_at: Date.now() / 1000, status: "completed", output: [item], usage } });
		} else {
			const item = { type: "message", id: `msg_boundary_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: "LOCAL_BOUNDARY_OK", annotations: [] }] };
			emit({ type: "response.created", response: { id: `resp_${index}` } });
			emit({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
			emit({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "LOCAL_BOUNDARY_OK" });
			emit({ type: "response.output_item.done", output_index: 0, item });
			emit({ type: "response.completed", response: { id: `resp_${index}`, status: "completed", output: [item], usage } });
		}
		res.end();
	} catch (error) { fatal = error; res.writeHead(500); res.end("local fixture failed"); }
});
const records = async () => {
	try { return (await readFile(eventsFile, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
	catch { return []; }
};
const waitFor = async (name: string, count: number) => {
	const deadline = Date.now() + 20000;
	while (Date.now() < deadline) {
		if (fatal) throw fatal;
		const all = await records();
		const items = all.filter(e => e.event === name);
		if (name === "compact") {
			const failed = all.find(e => e.event === "compact_failed");
			if (failed) throw new Error(`CLI compaction failed: ${failed.data.errorMessage}`);
		}
		if (items.length >= count) return items[count - 1];
		if (current?.exitCode !== null) throw new Error(`CLI exited early while waiting for ${name}: ${current?.exitCode}`);
		await sleep(50);
	}
	throw new Error(`Timed out waiting for ${name} #${count}`);
};
let starts = 0, settled = 0, compactions = 0, mcpChanges = 0;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const launch = async (session?: string) => {
	const args = [node, cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--no-tools",
		"-e", packageDir, "-e", "builtin:mcp", "-e", path.join(root, "observer.ts"), "--model", "local-boundary/pi-boundary", "--thinking", "off",
		...(session ? ["--session", session] : ["--session-id", `boundary-${capability}`])];
	await appendFile(path.join(root, "commands.log"), args.map(quote).join(" ") + "\n");
	current = spawn("script", ["-qefc", args.map(quote).join(" "), path.join(root, `pty-${starts + 1}.log`)], {
		cwd: root,
		// Allowlisted environment: no model credentials or auth state inherited.
		env: { PATH: process.env.PATH!, HOME: path.join(root, "home"), TMPDIR: root, TERM: "xterm-256color", COLUMNS: "100", LINES: "30", PI_OFFLINE: "1",
			PI_BOUNDARY_EVENTS: eventsFile, PI_BOUNDARY_SESSION: path.join(root, "branch.json"), PI_BOUNDARY_NODE: node, PI_BOUNDARY_MCP: path.join(root, "mcp-server.mjs") },
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	current.stderr!.on("data", chunk => { stderr += chunk; });
	current.stdout!.on("data", () => {});
	exited = new Promise((resolve, reject) => { current!.once("error", reject); current!.once("exit", code => resolve(code)); });
	const start = await waitFor("start", ++starts);
	assert.deepEqual(start.data, { mode: "tui", hasUI: true, stdinTTY: true, stdoutTTY: true });
	await sleep(300); // Let the TUI finish installing its keyboard reader.
};
const send = async (line: string) => {
	await appendFile(path.join(root, "inputs.log"), `${line.length > 100 ? line.slice(0, 60) + `… (${line.length} chars)` : line}\n`);
	current!.stdin!.write(line + "\r");
};
const prompt = async (text: string) => {
	await send(text);
	const event = await waitFor("settled", ++settled);
	assert.equal(event.data.stopReason, "stop");
	return wire[wire.length - 1].payload;
};
const compact = async () => {
	await send("/compact");
	const event = await waitFor("compact", ++compactions);
	assert.equal(event.data.branch.at(-1).details.strategy, "openai-native-compact-v2");
	return event.data.branch;
};
const mcp = async (version: string) => {
	await send(`/boundary-mcp ${version}`);
	await waitFor("mcp_registered", ++mcpChanges);
	await sleep(400);
};
const assertReplay = (payload: any, n: number) => {
	assert.ok(payload.input.some((i: any) => i.encrypted_content === `SYNTHETIC_ENCRYPTED_CHECKPOINT_${n}`), "CLI must send opaque native context, not Pi's placeholder summary");
	assert.ok(!JSON.stringify(payload).includes("OpenAI native compaction checkpoint"));
};
const shutdown = async () => {
	await send("/boundary-exit");
	assert.equal(await exited, 0, "real CLI/PTY process must exit successfully");
};
try {
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as any).port;
	const agent = path.join(root, "home/.pi/agent");
	await mkdir(path.join(agent, "extensions/pi-better-compaction"), { recursive: true });
	await writeFile(path.join(agent, "settings.json"), JSON.stringify({ quietStartup: true, compaction: { enabled: false, keepRecentTokens: 400 }, retry: { enabled: false } }));
	await writeFile(path.join(agent, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }));
	await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { "local-boundary": {
		baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-responses", apiKey: "local-test-only-not-a-credential",
		models: [{ id: "pi-boundary", name: "Local boundary fixture", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(capability === "absent" ? {} : { compat: { supportsMidConvoSystemMessages: capability === "true" } }) }],
	} } }));
	await writeFile(path.join(agent, "extensions/pi-better-compaction/config.json"), JSON.stringify({ debug: true, logProviderPayloads: true, logCompactResponses: true, compactionVersion: "v2", notifyOnLoad: true }));
	await cp(path.join(repo, "test/fixtures/cli-observer.ts"), path.join(root, "observer.ts"));
	await cp(path.join(repo, "test/fixtures/cli-mcp-server.mjs"), path.join(root, "mcp-server.mjs"));
	await launch();
	await prompt("OLDER_CONTEXT " + "o".repeat(8000));
	await prompt("KEPT_USER " + "k".repeat(1600));
	await mcp("v1");
	await prompt("MCP_BEFORE_COMPACTION");
	const firstBranch = await compact();
	const first = firstBranch.at(-1);
	const keptIndex = firstBranch.findIndex((e: any) => e.id === first.firstKeptEntryId);
	assert.ok(firstBranch.slice(keptIndex, -1).some((e: any) => e.message?.role === "system" && e.message.sections?.mcp_servers), "MCP update must lie inside the retained pre-compaction range");
	assert.ok(first.systemMessage.sections.mcp_servers.includes("LOCAL_MCP_DESCRIPTION_v1"));
	// Give the second compaction a new kept span, rather than asking Pi to
	// compact a transcript whose entire visible tail is still under its budget.
	assertReplay(await prompt("POST_COMPACTION_CHECKPOINT " + "p".repeat(1600)), 1);
	await mcp("v2");
	const changed = await prompt("POST_COMPACTION_MCP_CHANGE");
	assertReplay(changed, 1);
	if (capability !== "true") assert.ok(JSON.stringify(changed.input[0]).includes("LOCAL_MCP_DESCRIPTION_v2"), "collapsed fresh prompt must include current MCP state");
	else assert.ok(changed.input.slice(1).some((i: any) => (i.role === "system" || i.role === "developer") && JSON.stringify(i).includes("LOCAL_MCP_DESCRIPTION_v2")), "native provider keeps MCP delta in transcript");
	const secondBranch = await compact();
	assert.ok(secondBranch.at(-1).systemMessage.sections.mcp_servers.includes("LOCAL_MCP_DESCRIPTION_v2"));
	assertReplay(await prompt("AFTER_SECOND_COMPACTION"), 2);
	await shutdown();
	const session = (await records()).filter(e => e.event === "exit").at(-1).data.sessionFile;
	await launch(session);
	await mcp("v2");
	assertReplay(await prompt("AFTER_RESUME"), 2);
	await shutdown();
	assert.equal(compactCount, 2);
	const version = spawnSync(node, [cli, "--version"], { encoding: "utf8" }).stdout.trim();
	assert.equal(version, "1.0.0");
	const summary = { version, capability, realPTY: true, packageLoaded: true, builtinMcp: true, compactions: compactCount, requestsCapturedAtLocalHttpBoundary: requestIndex, checkpointReplay: true, changedMcpReplay: true, secondCompactionReplay: true, resumeReplay: true, cliExits: [0, 0], modelBacked: false };
	await writeFile(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
	console.log(JSON.stringify(summary));
} catch (error) { fatal = error; console.error(error); process.exitCode = 1; }
finally {
	// Never leave a CLI, MCP child or listener running after the foreground test.
	if (current?.exitCode === null) {
		current.stdin!.write("/boundary-exit\r");
		const stopped = await Promise.race([exited!, sleep(3000).then(() => "timeout")]);
		if (stopped === "timeout") { current.kill("SIGTERM"); await exited; }
	}
	await new Promise<void>(resolve => server.close(() => resolve()));
	if (process.env.PI_CLI_EVIDENCE_DIR) await cp(root, process.env.PI_CLI_EVIDENCE_DIR, { recursive: true });
	await rm(root, { recursive: true, force: true });
}
