import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
