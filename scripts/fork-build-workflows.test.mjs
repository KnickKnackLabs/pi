import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release-kkl.yml", import.meta.url), "utf8");

test("fork CI and binary releases use pinned model data", () => {
	assert.match(ci, /run: npm run build:offline\s/);
	assert.doesNotMatch(ci, /run: npm run build\s/);
	assert.match(release, /run: \.\/scripts\/build-binaries\.sh --offline-model-data\s/);
});

test("binary publication requires the exact release-tag commit", () => {
	assert.match(release, /fetch-depth: 0/);
	const block = release.match(/- name: Verify source matches release tag\n        run: \|\n([\s\S]*?)(?=\n      - name:)/)?.[1];
	assert.ok(block, "release source validation step exists");
	const script = block.replace(/^          /gm, "");
	const dir = mkdtempSync(join(tmpdir(), "pi-release-ref-test-"));
	try {
		writeFileSync(join(dir, "git"), '#!/bin/sh\ncase "$2" in\n  refs/tags/*) printf "%s\\n" "$TAG_COMMIT" ;;\n  HEAD) printf "%s\\n" "$SOURCE_COMMIT" ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
		for (const source of ["same-commit", "different-commit"]) {
			const result = spawnSync("bash", ["-e", "-c", script], {
				encoding: "utf8",
				env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RELEASE_TAG: "v0.87.1-kkl.2", TAG_COMMIT: "same-commit", SOURCE_COMMIT: source },
			});
			assert.equal(result.status, source === "same-commit" ? 0 : 1, result.stderr + result.stdout);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
