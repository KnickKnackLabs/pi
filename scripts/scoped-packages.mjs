import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function scopedPackageNames(packages, scope) {
	const scopeName = scope.replace(/^@/, "");
	if (!/^[a-z0-9][a-z0-9-]*$/.test(scopeName)) {
		throw new Error("Scope must be a lowercase npm organization name, for example knickknacklabs.");
	}

	const publishedNames = new Map();
	const usedNames = new Set();

	for (const pkg of packages) {
		const basename = pkg.name.split("/").at(-1);
		const publishedName = `@${scopeName}/${basename}`;
		if (usedNames.has(publishedName)) {
			throw new Error(`Multiple packages would publish as ${publishedName}.`);
		}

		publishedNames.set(pkg.name, publishedName);
		usedNames.add(publishedName);
	}

	return publishedNames;
}

function rewriteDependencies(entry, publishedNames) {
	const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

	for (const field of dependencyFields) {
		const dependencies = entry[field] ?? {};
		for (const [importName, versionRange] of Object.entries(dependencies)) {
			const publishedName = publishedNames.get(importName);
			if (!publishedName || publishedName === importName) {
				continue;
			}

			// Keep import names intact; install the fork under those names.
			dependencies[importName] = `npm:${publishedName}@${versionRange}`;
		}
	}
}

export function scopeManifest(manifest, publishedNames) {
	const scoped = structuredClone(manifest);
	scoped.name = publishedNames.get(scoped.name) ?? scoped.name;
	rewriteDependencies(scoped, publishedNames);

	// Published copies belong to the fork; preserve each workspace's directory.
	const repository = typeof scoped.repository === "object" ? scoped.repository : {};
	scoped.repository = {
		...repository,
		type: "git",
		url: "git+https://github.com/KnickKnackLabs/pi.git",
	};
	scoped.homepage = "https://github.com/KnickKnackLabs/pi";
	scoped.bugs = { url: "https://github.com/KnickKnackLabs/pi/issues" };

	return scoped;
}

export function scopeShrinkwrap(shrinkwrap, publishedNames) {
	if (shrinkwrap.lockfileVersion !== 3 || !shrinkwrap.packages) {
		throw new Error("Scoped publication requires a version 3 npm shrinkwrap with a packages map.");
	}

	const scoped = structuredClone(shrinkwrap);
	scoped.name = publishedNames.get(scoped.name) ?? scoped.name;

	for (const [lockPath, entry] of Object.entries(scoped.packages)) {
		rewriteDependencies(entry, publishedNames);

		if (lockPath === "") {
			entry.name = scoped.name;
			continue;
		}

		for (const [importName, publishedName] of publishedNames) {
			const packagePath = `node_modules/${importName}`;
			const matchesPackage = lockPath === packagePath || lockPath.endsWith(`/${packagePath}`);
			if (importName === publishedName || !matchesPackage) {
				continue;
			}

			if (!entry.version || entry.link) {
				throw new Error(`Shrinkwrap entry ${lockPath} must have a registry package version, not a workspace link.`);
			}

			const basename = publishedName.split("/")[1];
			entry.name = publishedName;
			entry.resolved = `https://registry.npmjs.org/${publishedName}/-/${basename}-${entry.version}.tgz`;

			// The fork tarball has different metadata and therefore a different digest.
			delete entry.integrity;
		}
	}

	return scoped;
}

export function stageScopedPackage(sourceDirectory, stagedDirectory, packedFiles, publishedNames) {
	for (const { path, mode } of packedFiles) {
		if (path.startsWith("/") || path.split(/[\\/]/).includes("..")) {
			throw new Error(`Invalid npm pack path: ${path}`);
		}

		const stagedPath = join(stagedDirectory, path);
		mkdirSync(dirname(stagedPath), { recursive: true });
		copyFileSync(join(sourceDirectory, path), stagedPath);
		if (mode !== undefined) {
			chmodSync(stagedPath, mode);
		}
	}

	const manifestPath = join(stagedDirectory, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const scopedManifest = scopeManifest(manifest, publishedNames);
	writeFileSync(manifestPath, `${JSON.stringify(scopedManifest, null, "\t")}\n`);

	const hasShrinkwrap = packedFiles.some(({ path }) => path === "npm-shrinkwrap.json");
	if (hasShrinkwrap) {
		const shrinkwrapPath = join(stagedDirectory, "npm-shrinkwrap.json");
		const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
		const scopedShrinkwrap = scopeShrinkwrap(shrinkwrap, publishedNames);
		writeFileSync(shrinkwrapPath, `${JSON.stringify(scopedShrinkwrap, null, "\t")}\n`);
	}
}
