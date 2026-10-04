import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { scopedPackageNames, scopeManifest, scopeShrinkwrap, stageScopedPackage } from "./scoped-packages.mjs";

const packages = [{ name: "@earendil-works/pi-coding-agent" }, { name: "@earendil-works/pi-ai" }];
const names = scopedPackageNames(packages, "knickknacklabs");

test("requires an explicit lowercase scope and rejects colliding package names", () => {
	assert.deepEqual(scopedPackageNames(packages, "@knickknacklabs"), names);

	for (const scope of ["", "KnickKnackLabs", "a/b", "-org", "org space"]) {
		assert.throws(() => scopedPackageNames(packages, scope), /lowercase npm/);
	}

	const collidingPackages = [{ name: "@one/foo" }, { name: "@two/foo" }];
	assert.throws(() => scopedPackageNames(collidingPackages, "org"), /Multiple packages/);
});

test("renames packages and aliases sibling dependencies without rewriting import names or external dependencies", () => {
	const manifest = {
		name: packages[0].name,
		version: "0.87.1-kkl.1",
		dependencies: { "@earendil-works/pi-ai": "^0.87.1-kkl.1", chalk: "6.0.0" },
		optionalDependencies: { "@earendil-works/pi-ai": "^0.87.1-kkl.1" },
		devDependencies: { "@earendil-works/pi-ai": "^0.87.1-kkl.1" },
	};

	const scoped = scopeManifest(manifest, names);
	assert.equal(scoped.name, "@knickknacklabs/pi-coding-agent");
	for (const field of ["dependencies", "optionalDependencies", "devDependencies"]) {
		assert.equal(scoped[field]["@earendil-works/pi-ai"], "npm:@knickknacklabs/pi-ai@^0.87.1-kkl.1");
	}
	assert.equal(scoped.dependencies.chalk, "6.0.0");
	assert.equal(manifest.name, "@earendil-works/pi-coding-agent");
	assert.equal(manifest.dependencies["@earendil-works/pi-ai"], "^0.87.1-kkl.1");
});

test("published metadata points to the fork without changing source metadata or workspace directory", () => {
	const original = {
		name: packages[0].name,
		repository: {
			type: "git",
			url: "git+https://github.com/earendil-works/pi.git",
			directory: "packages/coding-agent",
		},
		homepage: "https://pi.dev",
		bugs: { url: "https://github.com/earendil-works/pi/issues" },
	};
	const scoped = scopeManifest(original, names);
	assert.deepEqual(scoped.repository, {
		type: "git",
		url: "git+https://github.com/KnickKnackLabs/pi.git",
		directory: "packages/coding-agent",
	});
	assert.equal(scoped.homepage, "https://github.com/KnickKnackLabs/pi");
	assert.equal(scoped.bugs.url, "https://github.com/KnickKnackLabs/pi/issues");
	assert.equal(original.repository.url, "git+https://github.com/earendil-works/pi.git");

	const stringRepository = scopeManifest({ name: packages[0].name, repository: "upstream/repo" }, names);
	assert.equal(stringRepository.repository.url, scoped.repository.url);
});

test("rewrites shrinkwrap registry targets while preserving dependency paths and external integrity", () => {
	const original = {
		name: packages[0].name,
		lockfileVersion: 3,
		packages: {
			"": { name: packages[0].name, dependencies: { "@earendil-works/pi-ai": "^0.87.1-kkl.1" } },
			"node_modules/@earendil-works/pi-ai": {
				version: "0.87.1-kkl.1",
				resolved: "https://registry.npmjs.org/upstream.tgz",
				integrity: "old-digest",
			},
			"node_modules/other/node_modules/@earendil-works/pi-ai": { version: "0.87.1-kkl.1" },
			"node_modules/chalk": {
				version: "6.0.0",
				resolved: "https://registry.npmjs.org/chalk.tgz",
				integrity: "chalk-digest",
			},
		},
	};

	const scoped = scopeShrinkwrap(original, names);
	assert.equal(scoped.name, "@knickknacklabs/pi-coding-agent");
	assert.equal(scoped.packages[""].name, scoped.name);
	assert.equal(scoped.packages[""].dependencies["@earendil-works/pi-ai"], "npm:@knickknacklabs/pi-ai@^0.87.1-kkl.1");

	const entry = scoped.packages["node_modules/@earendil-works/pi-ai"];
	assert.equal(entry.name, "@knickknacklabs/pi-ai");
	assert.equal(entry.resolved, "https://registry.npmjs.org/@knickknacklabs/pi-ai/-/pi-ai-0.87.1-kkl.1.tgz");
	assert.equal(entry.integrity, undefined);
	assert.equal(scoped.packages["node_modules/other/node_modules/@earendil-works/pi-ai"].name, "@knickknacklabs/pi-ai");
	assert.deepEqual(scoped.packages["node_modules/chalk"], original.packages["node_modules/chalk"]);
	assert.equal(original.packages["node_modules/@earendil-works/pi-ai"].integrity, "old-digest");
});

test("rejects unsupported shrinkwrap formats and workspace links", () => {
	assert.throws(() => scopeShrinkwrap({ lockfileVersion: 2 }, names), /version 3/);

	const linkedShrinkwrap = {
		lockfileVersion: 3,
		packages: {
			"node_modules/@earendil-works/pi-ai": { version: "0.87.1-kkl.1", link: true },
		},
	};
	assert.throws(() => scopeShrinkwrap(linkedShrinkwrap, names), /not a workspace link/);
});

test("stages only npm-selected files, leaving source manifests and built imports unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-scoped-packages-test-"));
	try {
		const source = join(root, "source");
		const destination = join(root, "staged");
		await mkdir(join(source, "dist"), { recursive: true });

		const manifest = `${JSON.stringify({
			name: packages[0].name,
			version: "0.87.1-kkl.1",
			files: ["dist"],
			bin: { pi: "dist/index.js" },
		})}\n`;
		const code = '#!/usr/bin/env node\nexport { something } from "@earendil-works/pi-ai";\n';
		await writeFile(join(source, "package.json"), manifest);
		await writeFile(join(source, "dist/index.js"), code);
		await chmod(join(source, "dist/index.js"), 0o755);
		await writeFile(join(source, "secret.txt"), "not selected by npm");

		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const packed = spawnSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
			cwd: source,
			encoding: "utf8",
		});
		assert.equal(packed.status, 0, packed.stderr);

		const packedFiles = JSON.parse(packed.stdout)[0].files;
		stageScopedPackage(source, destination, packedFiles, names);

		const stagedManifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"));
		assert.equal(stagedManifest.name, "@knickknacklabs/pi-coding-agent");
		if (process.platform !== "win32") {
			const executable = await stat(join(destination, "dist/index.js"));
			assert.equal(executable.mode & 0o777, 0o755);
		}
		assert.equal(await readFile(join(destination, "dist/index.js"), "utf8"), code);
		assert.equal(await readFile(join(source, "package.json"), "utf8"), manifest);

		await assert.rejects(readFile(join(destination, "secret.txt")), { code: "ENOENT" });
		assert.throws(
			() => stageScopedPackage(source, destination, [{ path: "../secret.txt" }], names),
			/Invalid npm pack path/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("publish CLI rejects a missing scope before inspecting packages or contacting npm", () => {
	const script = fileURLToPath(new URL("./publish.mjs", import.meta.url));
	const invalidArguments = [[], ["--dry-run"], ["--scope"], ["--scope", "org", "--unexpected"]];

	for (const args of invalidArguments) {
		const result = spawnSync(process.execPath, [script, ...args], { cwd: tmpdir(), encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /explicit --scope|Usage:/);
		assert.equal(result.stdout, "");
	}
});
