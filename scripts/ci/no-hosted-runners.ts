import { readdir } from "node:fs/promises";
import { join } from "node:path";

type RecordValue = Record<string, unknown>;
const hosted = /^(ubuntu|windows|macos)-/;
const matrixPath = /^matrix\.([A-Za-z_][A-Za-z0-9_-]*)(?:\.([A-Za-z_][A-Za-z0-9_-]*))?$/;
const isRecord = (value: unknown): value is RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const owns = (value: RecordValue, key: string) => Object.hasOwn(value, key);

function unresolved(reason: string): never {
	throw new Error(`unresolvable runner: ${reason}`);
}

function equal(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => equal(item, b[i]));
	}
	if (isRecord(a) && isRecord(b)) {
		return Object.keys(a).length === Object.keys(b).length &&
			Object.entries(a).every(([key, value]) => owns(b, key) && equal(value, b[key]));
	}
	return false;
}

// Expand original combinations, then apply exclude/include with GitHub's semantics:
// includes can overwrite added properties, but never an original dimension value.
// An include that matches no original combination creates a standalone job.
function matrixRows(job: RecordValue): RecordValue[] {
	const strategy = job.strategy;
	if (!isRecord(strategy) || !isRecord(strategy.matrix)) {
		return unresolved("matrix must be a static mapping");
	}
	const matrix = strategy.matrix;
	const dimensions = Object.entries(matrix).filter(([key]) => key !== "include" && key !== "exclude");
	let rows: RecordValue[] = dimensions.length ? [{}] : [];
	for (const [key, values] of dimensions) {
		if (!Array.isArray(values) || values.length === 0) {
			return unresolved(`matrix.${key} must be a nonempty list`);
		}
		if (rows.length * values.length > 1024) return unresolved("matrix expansion exceeds 1024 combinations");
		rows = rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value })));
	}
	function entries(key: string): RecordValue[] {
		if (!owns(matrix, key)) return [];
		const value = matrix[key];
		if (!Array.isArray(value) || !value.every(isRecord)) {
			return unresolved(`matrix.${key} must be a list of mappings`);
		}
		return value;
	}
	const excludes = entries("exclude");
	rows = rows.filter((row) => !excludes.some((entry) =>
		Object.entries(entry).every(([key, value]) => owns(row, key) && equal(row[key], value))));
	const originals = rows.map((row) => ({ ...row }));
	const standalone: RecordValue[] = [];
	for (const entry of entries("include")) {
		let matched = false;
		originals.forEach((original, i) => {
			if (Object.entries(entry).every(([key, value]) => !owns(original, key) || equal(original[key], value))) {
				rows[i] = { ...rows[i], ...entry };
				matched = true;
			}
		});
		if (!matched) standalone.push(entry);
	}
	rows.push(...standalone);
	if (!rows.length || rows.length > 1024) return unresolved("matrix has no resolvable jobs or exceeds 1024 combinations");
	return rows;
}

// Only documented runs-on forms are supported. No annotation grants exceptions.
function runnerValues(value: unknown, strict: boolean): string[] {
	const values: string[] = [];
	function scalar(item: unknown) {
		if (typeof item !== "string" || !item.trim()) {
			if (strict) unresolved("runner values must be nonempty plain strings");
		} else values.push(item);
	}
	function labels(item: unknown) {
		if (Array.isArray(item)) {
			if (strict && !item.length) unresolved("runner label list is empty");
			item.forEach(scalar);
		} else scalar(item);
	}
	if (isRecord(value)) {
		if (strict && (Object.keys(value).some((key) => key !== "labels" && key !== "group") ||
			(!owns(value, "labels") && !owns(value, "group")))) {
			unresolved("runner mapping supports only labels/group");
		}
		if (owns(value, "labels")) labels(value.labels);
		if (owns(value, "group")) scalar(value.group);
	} else labels(value);
	return values;
}

function resolve(label: string, row: RecordValue): string {
	const resolved = label.replace(/\$\{\{([\s\S]*?)\}\}/g, (_expression, body: string) => {
		const path = matrixPath.exec(body.trim());
		if (!path) return unresolved(`unsupported expression: ${body.trim()}`);
		const key = path[1]!;
		if (!owns(row, key)) return unresolved(`matrix.${key} is missing`);
		let value = row[key];
		if (path[2]) {
			if (!isRecord(value) || !owns(value, path[2])) return unresolved(`matrix.${key}.${path[2]} is missing`);
			value = value[path[2]];
		}
		if (typeof value !== "string" || !value.trim()) {
			return unresolved(`matrix.${key}${path[2] ? `.${path[2]}` : ""} is not a plain string`);
		}
		return value;
	});
	if (resolved.includes("${{")) return unresolved("unterminated or nested expression");
	return resolved;
}

function checkRunner(value: unknown, job: RecordValue, strict: boolean) {
	const labels = runnerValues(value, strict);
	let rows: RecordValue[] = [{}];
	if (labels.some((label) => /\$\{\{\s*matrix\./.test(label))) {
		try { rows = matrixRows(job); }
		catch (error) { if (strict) throw error; }
	}
	for (const row of rows) {
		for (const label of labels) {
			let resolved: string;
			try { resolved = resolve(label, row); }
			catch (error) {
				if (strict) throw error;
				continue;
			}
			if (hosted.test(resolved)) throw new Error(`unapproved hosted runner: ${resolved}`);
		}
	}
}

async function main() {
	if (typeof Bun.YAML?.parse !== "function") throw new Error("Bun.YAML.parse is required");
	const directory = process.argv[2] ?? ".github/workflows";
	const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).sort();
	if (!files.length) throw new Error(`No workflows found in ${directory}`);
	let failed = false;
	for (const file of files) {
		const path = join(directory, file);
		let workflow: unknown;
		try {
			workflow = Bun.YAML.parse(await Bun.file(path).text());
		} catch (error) {
			console.error(`${path}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
			failed = true;
			continue;
		}
		if (!isRecord(workflow) || !isRecord(workflow.jobs) || !Object.keys(workflow.jobs).length) {
			console.error(`${path}: unresolvable runner: workflow must have a nonempty jobs mapping`);
			failed = true;
			continue;
		}
		for (const [name, job] of Object.entries(workflow.jobs)) {
			try {
				if (!isRecord(job)) unresolved("job must be a mapping");
				if (owns(job, "uses")) {
					// Reusable workflows do not select a runner here. Only reject a
					// runs-on input when its resolved value is a hosted label.
					if (isRecord(job.with) && owns(job.with, "runs-on")) checkRunner(job.with["runs-on"], job, false);
				} else checkRunner(job["runs-on"], job, true);
			} catch (error) {
				console.error(`${path}: job ${name}: ${error instanceof Error ? error.message : String(error)}`);
				failed = true;
			}
		}
	}
	if (failed) process.exitCode = 1;
	else console.log(`PASS: no hosted runners in ${files.length} workflow(s)`);
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
