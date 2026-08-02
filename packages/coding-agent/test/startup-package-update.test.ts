import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DefaultPackageManager,
	type ResolvedPaths,
	type StartupPackageUpdateResult,
} from "../src/core/package-manager.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { GitSource } from "../src/utils/git.ts";

function runGit(cwd: string, args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "tag.gpgSign=false", ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 10_000,
	}).trim();
}

function createTaggedGitRemote(root: string): { remote: string; source: string } {
	const remote = join(root, "remote.git");
	const source = join(root, "source");
	mkdirSync(remote, { recursive: true });
	mkdirSync(source, { recursive: true });
	runGit(remote, ["init", "--bare"]);
	runGit(source, ["init", "-b", "main"]);
	runGit(source, ["config", "user.name", "Pi Test"]);
	runGit(source, ["config", "user.email", "pi-test@example.com"]);
	mkdirSync(join(source, "extensions"), { recursive: true });
	writeFileSync(join(source, "extensions", "index.ts"), "export const version = '0.4.0';\n");
	runGit(source, ["add", "extensions/index.ts"]);
	runGit(source, ["commit", "-m", "v0.4.0"]);
	runGit(source, ["tag", "-a", "v0.4.0", "-m", "v0.4.0"]);
	runGit(source, ["remote", "add", "origin", remote]);
	runGit(source, ["push", "-u", "origin", "main", "--tags"]);
	runGit(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
	return { remote, source };
}

function publishGitVersion(source: string, version: string): string {
	writeFileSync(join(source, "extensions", "index.ts"), `export const version = '${version}';\n`);
	runGit(source, ["add", "extensions/index.ts"]);
	runGit(source, ["commit", "-m", version]);
	runGit(source, ["tag", "-a", version, "-m", version]);
	runGit(source, ["push", "origin", "main", "--tags"]);
	return runGit(source, ["rev-parse", "HEAD"]);
}

interface PackageManagerInternals {
	parseSource(source: string): GitSource | { type: "npm" | "local" };
	getGitInstallPath(source: GitSource, scope: "user" | "project"): string;
	installGitDependencies(targetDir: string): Promise<void>;
	gitSemverHasAvailableUpdate(source: GitSource, installedPath: string): Promise<boolean>;
}

function redirectGitSource(
	manager: DefaultPackageManager,
	declaration: string,
	remote: string,
	path: string,
): GitSource {
	const internals = manager as unknown as PackageManagerInternals;
	const originalParse = internals.parseSource.bind(manager);
	const parsed = originalParse(declaration);
	if (parsed.type !== "git") throw new Error("Expected Git source");
	const redirected: GitSource = { ...parsed, repo: remote, host: "local.test", path };
	vi.spyOn(internals, "parseSource").mockImplementation((source) =>
		source === declaration ? redirected : originalParse(source),
	);
	return redirected;
}

function cloneInstalledPackage(
	manager: DefaultPackageManager,
	source: GitSource,
	scope: "user" | "project",
	remote: string,
): string {
	const internals = manager as unknown as PackageManagerInternals;
	const installedPath = internals.getGitInstallPath(source, scope);
	mkdirSync(dirname(installedPath), { recursive: true });
	runGit(dirname(installedPath), ["clone", remote, installedPath]);
	runGit(installedPath, ["checkout", "v0.4.0"]);
	return installedPath;
}

const emptyResolvedPaths = (): ResolvedPaths => ({ extensions: [], skills: [], prompts: [], themes: [] });

describe("startup package updates", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let previousOffline: string | undefined;

	beforeEach(() => {
		previousOffline = process.env.PI_OFFLINE;
		delete process.env.PI_OFFLINE;
		tempDir = join(tmpdir(), `startup-update-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips the startup update policy in package settings", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				packages: [{ source: "git:github.com/example/repo@~0.4.0", update: "startup", skills: [] }],
			}),
		);

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getPackages()).toEqual([
			{ source: "git:github.com/example/repo@~0.4.0", update: "startup", skills: [] },
		]);
	});

	it("updates one effective opted-in Git range and returns a structured result", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "clean-update"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/clean-update");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		const targetHead = publishGitVersion(fixture.source, "v0.4.1");

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining<Partial<StartupPackageUpdateResult>>({
				source: declaration,
				scope: "user",
				status: "updated",
				previousHead: expect.any(String),
				targetHead,
				targetTag: "v0.4.1",
			}),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(targetHead);
		expect(readFileSync(join(installedPath, "extensions", "index.ts"), "utf-8")).toContain("0.4.1");
	});

	it("uses the opted-in user source behind a project autoload delta", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "delta-update"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		settings.setProjectPackages([{ source: declaration, autoload: false, extensions: ["extensions/index.ts"] }]);
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/delta-update");
		cloneInstalledPackage(manager, source, "user", fixture.remote);
		publishGitVersion(fixture.source, "v0.4.1");

		const results = await manager.applyStartupUpdates();

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ source: declaration, scope: "user", status: "updated" });
	});

	it("updates a standalone project package with autoload disabled", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "project-autoload-disabled"));
		const settings = SettingsManager.inMemory();
		settings.setProjectPackages([
			{ source: declaration, update: "startup", autoload: false, extensions: ["+extensions/index.ts"] },
		]);
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/project-autoload-disabled");
		const installedPath = cloneInstalledPackage(manager, source, "project", fixture.remote);
		const targetHead = publishGitVersion(fixture.source, "v0.4.1");

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining({ source: declaration, scope: "project", status: "updated", targetHead }),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(targetHead);
	});

	it("refuses a dirty checkout before changing it", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "dirty-update"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/dirty-update");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		const originalHead = runGit(installedPath, ["rev-parse", "HEAD"]);
		writeFileSync(join(installedPath, "extensions", "index.ts"), "local work\n");
		publishGitVersion(fixture.source, "v0.4.1");

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining({ source: declaration, scope: "user", status: "refused-dirty", phase: "classify" }),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(originalHead);
		expect(readFileSync(join(installedPath, "extensions", "index.ts"), "utf-8")).toBe("local work\n");
	});

	it("refuses a clean checkout with a local commit", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "ahead-update"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/ahead-update");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		runGit(installedPath, ["config", "user.name", "Pi Test"]);
		runGit(installedPath, ["config", "user.email", "pi-test@example.com"]);
		writeFileSync(join(installedPath, "local.txt"), "preserve me\n");
		runGit(installedPath, ["add", "local.txt"]);
		runGit(installedPath, ["commit", "-m", "local commit"]);
		const localHead = runGit(installedPath, ["rev-parse", "HEAD"]);
		publishGitVersion(fixture.source, "v0.4.1");

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining({ source: declaration, scope: "user", status: "refused-diverged", phase: "classify" }),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(localHead);
		expect(existsSync(join(installedPath, "local.txt"))).toBe(true);
	});

	it("reports offline without checking or changing the checkout", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "offline-update"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/offline-update");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		const originalHead = runGit(installedPath, ["rev-parse", "HEAD"]);
		publishGitVersion(fixture.source, "v0.4.1");
		process.env.PI_OFFLINE = "1";

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining({ source: declaration, scope: "user", status: "skipped-offline" }),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(originalHead);
	});

	it("records a successful current check and skips the next fresh check", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "fresh-check"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/fresh-check");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);

		const first = await manager.applyStartupUpdates();
		expect(first).toEqual([
			expect.objectContaining({
				source: declaration,
				scope: "user",
				status: "current",
				checkedAt: expect.any(Number),
			}),
		]);

		runGit(installedPath, ["remote", "set-url", "origin", join(tempDir, "missing.git")]);
		const second = await manager.applyStartupUpdates();
		expect(second).toEqual([
			expect.objectContaining({ source: declaration, scope: "user", status: "skipped-fresh" }),
		]);
	});

	it("preserves the old checkout when staged dependency installation fails", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "dependency-failure"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/dependency-failure");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		const originalHead = runGit(installedPath, ["rev-parse", "HEAD"]);
		publishGitVersion(fixture.source, "v0.4.1");
		vi.spyOn(manager as unknown as PackageManagerInternals, "installGitDependencies").mockRejectedValue(
			new Error("dependency install failed"),
		);

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining({
				source: declaration,
				scope: "user",
				status: "failed",
				phase: "prepare",
				message: "dependency install failed",
			}),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(originalHead);
		expect(readFileSync(join(installedPath, "extensions", "index.ts"), "utf-8")).toContain("0.4.0");
	});

	it("defers while another process holds the package update lock", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "locked-update"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/locked-update");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		const lockTarget = join(dirname(installedPath), `.${basename(installedPath)}.startup-update`);
		const release = await lockfile.lock(lockTarget, { realpath: false, retries: 0 });
		try {
			const results = await manager.applyStartupUpdates();
			expect(results).toEqual([
				expect.objectContaining({ source: declaration, scope: "user", status: "deferred-locked", phase: "lock" }),
			]);
		} finally {
			await release();
		}
	});

	it("reports a remote check failure without changing the checkout", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "remote-failure"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/remote-failure");
		const installedPath = cloneInstalledPackage(manager, source, "user", fixture.remote);
		const originalHead = runGit(installedPath, ["rev-parse", "HEAD"]);
		runGit(installedPath, ["remote", "set-url", "origin", join(tempDir, "missing.git")]);

		const results = await manager.applyStartupUpdates();

		expect(results).toEqual([
			expect.objectContaining({ source: declaration, scope: "user", status: "failed", phase: "check" }),
		]);
		expect(runGit(installedPath, ["rev-parse", "HEAD"])).toBe(originalHead);
	});

	it("omits startup-managed packages from the advisory update check", async () => {
		const declaration = "git:github.com/example/repo@~0.4.0";
		const fixture = createTaggedGitRemote(join(tempDir, "advisory-dedupe"));
		const settings = SettingsManager.inMemory({ packages: [{ source: declaration, update: "startup" }] });
		const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager: settings });
		const source = redirectGitSource(manager, declaration, fixture.remote, "example/advisory-dedupe");
		cloneInstalledPackage(manager, source, "user", fixture.remote);
		const check = vi.spyOn(manager as unknown as PackageManagerInternals, "gitSemverHasAvailableUpdate");

		expect(await manager.checkForAvailableUpdates()).toEqual([]);
		expect(check).not.toHaveBeenCalled();
	});

	it("runs startup updates after settings reload and before package resolution", async () => {
		const order: string[] = [];
		vi.spyOn(DefaultPackageManager.prototype, "applyStartupUpdates").mockImplementation(async () => {
			order.push("startup-update");
			return [];
		});
		vi.spyOn(DefaultPackageManager.prototype, "resolve").mockImplementation(async () => {
			order.push("resolve");
			return emptyResolvedPaths();
		});
		const settings = SettingsManager.inMemory();
		vi.spyOn(settings, "reload").mockImplementation(async () => {
			order.push("settings-reload");
		});
		const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager: settings });

		await loader.reload();

		expect(order.slice(0, 3)).toEqual(["settings-reload", "startup-update", "resolve"]);
		expect(loader.getStartupPackageUpdateResults()).toEqual([]);
	});
});
