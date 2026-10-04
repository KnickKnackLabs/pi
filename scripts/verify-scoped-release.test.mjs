import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./verify-scoped-release.mjs", import.meta.url));

test("consumer verifier rejects missing or invalid scope before workspace inspection or registry access", () => {
	for (const args of [[], ["--scope"], ["--scope", "KnickKnackLabs"], ["--scope", "org", "--publish"]]) {
		const result = spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Usage:|lowercase npm/);
		assert.equal(result.stdout, "");
	}
});

test("runtime fixture resolves nested shrinkwrapped siblings without top-level hoisting", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-nested-consumer-test-"));
	try {
		const codingAgent = join(root, "node_modules/@earendil-works/pi-coding-agent");
		const nested = join(codingAgent, "node_modules/@earendil-works");
		await mkdir(nested, { recursive: true });
		await writeFile(join(codingAgent, "package.json"), JSON.stringify({ name: "@knickknacklabs/pi-coding-agent", type: "module", exports: { ".": { import: "./index.js" } } }));
		await writeFile(join(codingAgent, "index.js"), "export function createAgentSession() {}\n");
		const siblings = {
			"pi-agent-core": "export class Agent {}\n",
			"pi-ai": "export const Type = { Object() {} };\n",
			"pi-tui": "export class Text { constructor(text) { this.text = text; } render(width) { return [this.text.padEnd(width)]; } }\n",
		};
		const packages = {};
		for (const [name, source] of Object.entries(siblings)) {
			const directory = join(nested, name);
			await mkdir(directory);
			await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@knickknacklabs/${name}`, type: "module", exports: { ".": { import: "./index.js" } } }));
			await writeFile(join(directory, "index.js"), source);
			packages[`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/${name}`] = { name: `@knickknacklabs/${name}`, version: "1.2.3" };
		}
		packages["node_modules/@earendil-works/pi-coding-agent"] = { name: "@knickknacklabs/pi-coding-agent", version: "1.2.3" };
		const lockfile = join(root, "package-lock.json");
		await writeFile(lockfile, JSON.stringify({ packages }));
		const fixture = join(codingAgent, "consumer-check.mjs");
		await copyFile(fileURLToPath(new URL("./fixtures/scoped-consumer/imports.mjs", import.meta.url)), fixture);
		const result = spawnSync(process.execPath, [fixture], {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, PI_CONSUMER_SCOPE: "knickknacklabs", PI_CONSUMER_VERSION: "1.2.3", PI_CONSUMER_LOCKFILE: lockfile },
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /Verified 4 fork packages/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("failed registry verification removes its temporary consumer and never publishes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-consumer-verifier-test-"));
	try {
		const temporaryDirectory = join(root, "temporary");
		await mkdir(temporaryDirectory);
		for (const name of ["pi-coding-agent", "pi-ai"]) {
			const directory = join(root, "packages", name);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, "package.json"),
				JSON.stringify({ name: `@earendil-works/${name}`, version: "1.2.3" }),
			);
		}
		const result = spawnSync(process.execPath, [script, "--scope", "consumer-test-org"], {
			cwd: root,
			encoding: "utf8",
			timeout: 20_000,
			env: {
				...process.env,
				TMPDIR: temporaryDirectory,
				TMP: temporaryDirectory,
				TEMP: temporaryDirectory,
				npm_config_registry: "http://127.0.0.1:1",
				npm_config_offline: "true",
				npm_config_fetch_retries: "0",
			},
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Consumer check failed: npm pack/);
		const remaining = await readdir(temporaryDirectory);
		assert.deepEqual(
			remaining.filter((name) => name.startsWith("pi-published-consumer-")),
			[],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
