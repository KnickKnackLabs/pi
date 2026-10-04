#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getPublicWorkspacePackages } from "./release-packages.mjs";
import { scopedPackageNames, stageScopedPackage } from "./scoped-packages.mjs";

let dryRun = false;
let packOnly = false;
let scope;
let outputDirectory;
const usage = "Usage: node scripts/publish.mjs --scope <npm-org> [--dry-run | --pack-only --out <directory>]";
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
	const arg = args[index];

	if (arg === "--dry-run" && !dryRun) {
		dryRun = true;
		continue;
	}

	if (arg === "--pack-only" && !packOnly) {
		packOnly = true;
		continue;
	}

	if (arg === "--out" && outputDirectory === undefined) {
		const value = args[++index];
		if (value && !value.startsWith("--")) {
			outputDirectory = resolve(value);
			continue;
		}
	}

	if (arg === "--scope" && scope === undefined) {
		const value = args[++index];
		if (value && !value.startsWith("--")) {
			scope = value;
			continue;
		}
	}

	console.error(usage);
	process.exit(1);
}

if (!scope) {
	console.error("An explicit --scope is required; no registry queries or publication performed.");
	process.exit(1);
}

if (dryRun && packOnly) {
	console.error("Choose either --dry-run or --pack-only, not both.");
	process.exit(1);
}

if (packOnly !== Boolean(outputDirectory)) {
	console.error("--pack-only requires --out <directory>; --out is only valid with --pack-only.");
	process.exit(1);
}

if (outputDirectory && existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
	console.error(`Output directory must be empty: ${outputDirectory}`);
	process.exit(1);
}

const packages = getPublicWorkspacePackages();
const publishedNames = scopedPackageNames(packages, scope);

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		const message = `Command failed: ${command} ${args.join(" ")}`;
		throw new Error(output ? `${message}\n${output}` : message);
	}

	return result;
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
		capture: true,
		cwd: directory,
	});
	const packed = JSON.parse(result.stdout)[0];

	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
	return packed;
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

function packPackages(packages, outputDirectory) {
	mkdirSync(outputDirectory, { recursive: true });

	for (const pkg of packages) {
		const result = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", outputDirectory], {
			capture: true,
			cwd: pkg.directory,
		});
		const packed = JSON.parse(result.stdout)[0];
		console.log(`Saved ${join(outputDirectory, packed.filename)}`);
	}

	console.log("\nPacking complete. No registry queries or publication performed.");
}

function publishPackages(packages, dryRun) {
	const validatedPackages = packages.map((pkg) => {
		const published = isPublished(pkg.name, pkg.version);
		console.log(`${pkg.name}@${pkg.version}: ${published ? "already published" : "not published"}`);
		validatePack(pkg.directory);
		console.log();

		return { ...pkg, published };
	});

	if (dryRun) {
		return;
	}

	console.log("All packages validated; starting publication.\n");
	for (const pkg of validatedPackages) {
		if (pkg.published) {
			console.log(`Skipping ${pkg.name}@${pkg.version}: already published\n`);
			continue;
		}

		run("npm", ["publish", "--tag", "latest", "--access", "public", "--provenance", "--ignore-scripts"], {
			cwd: pkg.directory,
		});
		console.log();
	}
}

const versions = [...new Set(packages.map((pkg) => pkg.version))];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

const action = packOnly ? "Packing" : "Publishing";
console.log(`${action} pi packages under @${scope.replace(/^@/, "")} at ${versions[0]}${dryRun ? " (dry run)" : ""}\n`);

const stagingRoot = mkdtempSync(join(tmpdir(), "pi-scoped-publish-"));
try {
	const stagedPackages = packages.map((sourcePackage, index) => {
		assertBuildOutputExists(sourcePackage.directory);
		const packed = validatePack(sourcePackage.directory);

		const stagedDirectory = join(stagingRoot, String(index));
		stageScopedPackage(sourcePackage.directory, stagedDirectory, packed.files, publishedNames);

		return {
			name: publishedNames.get(sourcePackage.name),
			version: sourcePackage.version,
			directory: stagedDirectory,
		};
	});

	if (packOnly) {
		packPackages(stagedPackages, outputDirectory);
	} else {
		publishPackages(stagedPackages, dryRun);
	}
} finally {
	rmSync(stagingRoot, { recursive: true, force: true });
}
