#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { scopedPackageNames } from "./scoped-packages.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--scope") {
	console.error("Usage: node scripts/verify-scoped-release.mjs --scope <npm-org>");
	process.exit(1);
}

// Validate the explicit scope before reading workspaces or contacting npm.
scopedPackageNames([], args[1]);
const packages = getPublicWorkspacePackages();
const publishedNames = scopedPackageNames(packages, args[1]);
const scope = args[1].replace(/^@/, "");
const versions = new Set(packages.map((pkg) => pkg.version));
assert.equal(versions.size, 1, "Public packages must share one release version");
const version = packages[0].version;
const codingAgentName = publishedNames.get("@earendil-works/pi-coding-agent");
assert.ok(codingAgentName, "Release must contain pi-coding-agent");
const compiler = resolve("node_modules/.bin/tsc");
const fixtures = fileURLToPath(new URL("./fixtures/scoped-consumer/", import.meta.url));
const consumerDirectory = mkdtempSync(join(tmpdir(), "pi-published-consumer-"));

function run(command, args, capture = false) {
	const executable = process.platform === "win32" && command !== process.execPath ? `${command}.cmd` : command;
	const result = spawnSync(executable, args, {
		cwd: consumerDirectory,
		encoding: "utf8",
		timeout: 120_000,
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
		env: {
			...process.env,
			PI_CONSUMER_SCOPE: scope,
			PI_CONSUMER_VERSION: version,
			PI_CONSUMER_LOCKFILE: join(consumerDirectory, "package-lock.json"),
		},
	});
	if (result.error || result.status !== 0) {
		throw new Error(`Consumer check failed: ${command} ${args.join(" ")}\n${result.error ?? result.stderr ?? ""}`);
	}
	return result.stdout;
}

try {
	// Download every public archive: metadata alone cannot prove it is available.
	for (const pkg of packages) {
		const publishedName = publishedNames.get(pkg.name);
		const output = run("npm", ["pack", `${publishedName}@${version}`, "--ignore-scripts", "--json"], true);
		const packed = JSON.parse(output)[0];
		assert.equal(packed.name, publishedName);
		assert.equal(packed.version, version);
		console.log(`Downloaded ${publishedName}@${version}`);
	}

	// Supply only coding-agent; npm must obtain its matching fork siblings itself.
	writeFileSync(
		join(consumerDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "pi-published-consumer",
				version: "0.0.0",
				private: true,
				type: "module",
				dependencies: { "@earendil-works/pi-coding-agent": `npm:${codingAgentName}@${version}` },
			},
			null,
			"\t",
		)}\n`,
	);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--fetch-retries=0"]);
	copyFileSync(join(fixtures, "extension.ts"), join(consumerDirectory, "extension.ts"));
	// npm may keep shrinkwrapped siblings nested rather than hoisting them.
	const runtimeFixture = join(consumerDirectory, "node_modules/@earendil-works/pi-coding-agent/consumer-check.mjs");
	copyFileSync(join(fixtures, "imports.mjs"), runtimeFixture);
	run(compiler, [
		"--noEmit",
		"--strict",
		"--skipLibCheck",
		"--target",
		"ES2022",
		"--module",
		"ESNext",
		"--moduleResolution",
		"Bundler",
		"extension.ts",
	]);
	run(process.execPath, [runtimeFixture]);
	console.log("Published consumer check passed (dependency declaration checking skipped).");
} finally {
	rmSync(consumerDirectory, { recursive: true, force: true });
}
