import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const publishScript = fileURLToPath(new URL("./publish.mjs", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function runPackCommand(directory, args) {
	return spawnSync(process.execPath, [publishScript, "--scope", "pack-test-org", ...args], {
		cwd: directory,
		encoding: "utf8",
		timeout: 20_000,
		env: {
			...process.env,
			// A registry operation must fail, even if these package names exist on npm.
			npm_config_registry: "http://127.0.0.1:1",
			npm_config_offline: "true",
			npm_config_fetch_retries: "0",
		},
	});
}

async function writePackage(root, directoryName, manifest) {
	const directory = join(root, "packages", directoryName);
	await mkdir(join(directory, "dist"), { recursive: true });
	await writeFile(join(directory, "package.json"), JSON.stringify({
		...manifest,
		version: manifest.version ?? "1.2.3",
		files: ["dist"],
		scripts: { prepack: "node prepack.mjs" },
	}));
	await writeFile(join(directory, "dist/index.js"), "export const value = 42;\n");
	await writeFile(join(directory, "prepack.mjs"), 'throw new Error("Pack commands must not run lifecycle scripts");\n');
}

function readPackedManifest(tarball) {
	const result = spawnSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("pack-only saves scoped tarballs without registry access, lifecycle scripts, or source edits", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pack-command-test-"));
	try {
		await writePackage(root, "ai", { name: "@earendil-works/pi-ai" });
		await writePackage(root, "agent", {
			name: "@earendil-works/pi-agent-core",
			dependencies: { "@earendil-works/pi-ai": "^1.2.3" },
		});
		const sourceManifestPath = join(root, "packages/agent/package.json");
		const originalManifest = await readFile(sourceManifestPath, "utf8");

		const result = runPackCommand(root, ["--pack-only", "--out", "artifacts"]);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /No registry queries or publication performed/);

		const outputDirectory = join(root, "artifacts");
		assert.deepEqual((await readdir(outputDirectory)).sort(), [
			"pack-test-org-pi-agent-core-1.2.3.tgz",
			"pack-test-org-pi-ai-1.2.3.tgz",
		]);
		const manifest = readPackedManifest(join(outputDirectory, "pack-test-org-pi-agent-core-1.2.3.tgz"));
		assert.equal(manifest.name, "@pack-test-org/pi-agent-core");
		assert.equal(manifest.dependencies["@earendil-works/pi-ai"], "npm:@pack-test-org/pi-ai@^1.2.3");
		assert.equal(await readFile(sourceManifestPath, "utf8"), originalManifest);

		// npm must be able to read the saved archive after staging has been removed.
		const inspected = spawnSync(npm, ["pack", join(outputDirectory, "pack-test-org-pi-ai-1.2.3.tgz"), "--dry-run", "--ignore-scripts", "--json"], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(inspected.status, 0, inspected.stderr);
		assert.equal(JSON.parse(inspected.stdout)[0].name, "@pack-test-org/pi-ai");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("publication explicitly tags fork prereleases and keeps provenance and lifecycle guards", { skip: process.platform === "win32" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-publish-command-test-"));
	try {
		await writePackage(root, "ai", { name: "@earendil-works/pi-ai", version: "0.87.1-kkl.2" });
		const bin = join(root, "bin");
		await mkdir(bin);
		const shim = join(bin, "npm");
		const log = join(root, "npm-calls.jsonl");
		// Only packing delegates to real npm. Registry queries and publication are inert.
		await writeFile(shim, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
appendFileSync(process.env.PI_TEST_NPM_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pack") {
  const result = spawnSync("npm", args, { stdio: "inherit", env: { ...process.env, PATH: process.env.PI_TEST_ORIGINAL_PATH } });
  process.exit(result.status ?? 1);
}
if (args[0] === "view") {
  console.error("E404 Not Found (offline test fixture)");
  process.exit(1);
}
if (args[0] !== "publish") process.exit(1);
`);
		await chmod(shim, 0o755);
		const result = spawnSync(process.execPath, [publishScript, "--scope", "pack-test-org"], {
			cwd: root,
			encoding: "utf8",
			timeout: 20_000,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				PI_TEST_ORIGINAL_PATH: process.env.PATH,
				PI_TEST_NPM_LOG: log,
				npm_config_offline: "true",
			},
		});
		assert.equal(result.status, 0, result.stderr);
		const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(calls.filter((args) => args[0] === "publish"), [
			["publish", "--tag", "latest", "--access", "public", "--provenance", "--ignore-scripts"],
		]);
		assert.ok(calls.some((args) => args[0] === "view" && args[1] === "@pack-test-org/pi-ai@0.87.1-kkl.2"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pack-only refuses non-empty output directories without overwriting existing files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-pack-output-test-"));
	try {
		const outputDirectory = join(root, "artifacts");
		await mkdir(outputDirectory);
		const existingFile = join(outputDirectory, "keep.txt");
		await writeFile(existingFile, "keep this output");

		const result = runPackCommand(root, ["--pack-only", "--out", outputDirectory]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Output directory must be empty/);
		assert.equal(await readFile(existingFile, "utf8"), "keep this output");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("pack-only rejects conflicting modes, a missing output path, and output paths in publishing mode", () => {
	const invalidArguments = [
		["--pack-only"],
		["--out", "artifacts"],
		["--pack-only", "--out"],
		["--pack-only", "--out", "artifacts", "--dry-run"],
	];

	for (const args of invalidArguments) {
		const result = runPackCommand(tmpdir(), args);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Usage:|requires --out|Choose either/);
		assert.equal(result.stdout, "");
	}
});
