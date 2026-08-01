import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { GitSource } from "../utils/git.ts";
import { type GitSemverTag, isGitTagCompatible, selectLatestCompatibleGitTag } from "../utils/git-semver.ts";
import { resolvePath } from "../utils/paths.ts";

export const STARTUP_PACKAGE_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type StartupPackageUpdateScope = "user" | "project";

export type StartupPackageUpdateStatus =
	| "current"
	| "updated"
	| "skipped-fresh"
	| "not-installed"
	| "skipped-offline"
	| "skipped-ineligible"
	| "refused-dirty"
	| "refused-diverged"
	| "deferred-locked"
	| "failed";

export type StartupPackageUpdatePhase = "lock" | "classify" | "check" | "prepare" | "apply" | "persist";

export interface StartupPackageUpdateResult {
	source: string;
	scope: StartupPackageUpdateScope;
	status: StartupPackageUpdateStatus;
	phase?: StartupPackageUpdatePhase;
	previousHead?: string;
	targetHead?: string;
	targetTag?: string;
	checkedAt?: number;
	message?: string;
}

interface StartupPackageUpdateStateRecord {
	source: string;
	scope: StartupPackageUpdateScope;
	checkedAt: number;
	targetHead: string;
	targetTag: string;
}

interface StartupGitPackageUpdateOperations {
	checkoutHasChanges(path: string): Promise<boolean>;
	getHead(path: string): Promise<string>;
	getRemoteTags(source: GitSource, installedPath: string): Promise<GitSemverTag[]>;
	prepareCheckout(source: GitSource, target: GitSemverTag, stagingPath: string): Promise<void>;
}

interface StartupGitPackageUpdateOptions {
	source: string;
	gitSource: GitSource;
	scope: StartupPackageUpdateScope;
	installedPath: string;
}

function isStateRecord(value: unknown): value is StartupPackageUpdateStateRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.source === "string" &&
		(record.scope === "user" || record.scope === "project") &&
		typeof record.checkedAt === "number" &&
		Number.isFinite(record.checkedAt) &&
		typeof record.targetHead === "string" &&
		typeof record.targetTag === "string"
	);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function appendMessage(current: string | undefined, next: string): string {
	return current ? `${current}; ${next}` : next;
}

function withPhase(error: unknown, phase: StartupPackageUpdatePhase): Error & { phase: StartupPackageUpdatePhase } {
	return Object.assign(new Error(describeError(error)), { phase });
}

class StartupPackageUpdateStateStore {
	private readonly stateDir: string;

	constructor(agentDir: string) {
		this.stateDir = join(resolvePath(agentDir), "package-update-state");
	}

	read(source: string, scope: StartupPackageUpdateScope): StartupPackageUpdateStateRecord | undefined {
		const path = this.getPath(source, scope);
		if (!existsSync(path)) return undefined;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
			return isStateRecord(parsed) && parsed.source === source && parsed.scope === scope ? parsed : undefined;
		} catch {
			return undefined;
		}
	}

	write(record: StartupPackageUpdateStateRecord): void {
		const path = this.getPath(record.source, record.scope);
		const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
		mkdirSync(dirname(path), { recursive: true });
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
			renameSync(temporaryPath, path);
		} finally {
			if (existsSync(temporaryPath)) rmSync(temporaryPath, { force: true });
		}
	}

	private getPath(source: string, scope: StartupPackageUpdateScope): string {
		const key = createHash("sha256").update(`${scope}\0${source}`).digest("hex");
		return join(this.stateDir, `${key}.json`);
	}
}

export class StartupGitPackageUpdater {
	private readonly state: StartupPackageUpdateStateStore;
	private readonly operations: StartupGitPackageUpdateOperations;

	constructor(agentDir: string, operations: StartupGitPackageUpdateOperations) {
		this.state = new StartupPackageUpdateStateStore(agentDir);
		this.operations = operations;
	}

	async apply(options: StartupGitPackageUpdateOptions): Promise<StartupPackageUpdateResult> {
		const { source, scope, installedPath } = options;
		if (!existsSync(installedPath)) return { source, scope, status: "not-installed" };

		const lockTarget = join(dirname(installedPath), `.${basename(installedPath)}.startup-update`);
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(lockTarget, { realpath: false, retries: 0 });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code === "ELOCKED") return { source, scope, status: "deferred-locked", phase: "lock" };
			return { source, scope, status: "failed", phase: "lock", message: describeError(error) };
		}

		let result: StartupPackageUpdateResult;
		try {
			result = await this.applyLocked(options);
		} catch (error) {
			const phase =
				typeof error === "object" && error !== null && "phase" in error
					? ((error as { phase?: StartupPackageUpdatePhase }).phase ?? "apply")
					: "apply";
			result = { source, scope, status: "failed", phase, message: describeError(error) };
		}

		try {
			await release();
		} catch (error) {
			const message = `Package update lock could not be released: ${describeError(error)}`;
			if (result.status === "updated") result.message = appendMessage(result.message, message);
			else result = { ...result, status: "failed", phase: "lock", message: appendMessage(result.message, message) };
		}
		return result;
	}

	private async applyLocked(options: StartupGitPackageUpdateOptions): Promise<StartupPackageUpdateResult> {
		const { source, gitSource, scope, installedPath } = options;
		let dirty: boolean;
		let previousHead: string;
		try {
			dirty = await this.operations.checkoutHasChanges(installedPath);
			previousHead = await this.operations.getHead(installedPath);
		} catch (error) {
			throw withPhase(error, "classify");
		}
		if (dirty) return { source, scope, status: "refused-dirty", phase: "classify" };
		const now = Date.now();
		const state = this.state.read(source, scope);
		if (
			state?.targetHead === previousHead &&
			now >= state.checkedAt &&
			now - state.checkedAt < STARTUP_PACKAGE_UPDATE_INTERVAL_MS
		) {
			return {
				source,
				scope,
				status: "skipped-fresh",
				previousHead,
				targetHead: state.targetHead,
				targetTag: state.targetTag,
				checkedAt: state.checkedAt,
			};
		}

		let tags: GitSemverTag[];
		try {
			tags = await this.operations.getRemoteTags(gitSource, installedPath);
		} catch (error) {
			throw withPhase(error, "check");
		}
		const currentTag = tags.find(
			(tag) => tag.commit === previousHead && isGitTagCompatible(tag.name, gitSource.range!),
		);
		if (!currentTag) {
			return { source, scope, status: "refused-diverged", phase: "classify", previousHead };
		}

		const target = selectLatestCompatibleGitTag(tags, gitSource.range!);
		if (!target) {
			return {
				source,
				scope,
				status: "failed",
				phase: "check",
				previousHead,
				message: `No Git tag satisfies ${gitSource.range} for ${gitSource.host}/${gitSource.path}`,
			};
		}

		const checkedAt = Date.now();
		if (target.commit === previousHead) {
			const message = this.writeState(source, scope, target, checkedAt);
			return {
				source,
				scope,
				status: "current",
				previousHead,
				targetHead: target.commit,
				targetTag: target.name,
				checkedAt,
				...(message ? { message } : {}),
			};
		}

		let message = await this.replaceCheckout(gitSource, installedPath, target);
		const stateMessage = this.writeState(source, scope, target, checkedAt);
		if (stateMessage) message = appendMessage(message, stateMessage);
		return {
			source,
			scope,
			status: "updated",
			previousHead,
			targetHead: target.commit,
			targetTag: target.name,
			checkedAt,
			...(message ? { message } : {}),
		};
	}

	private writeState(
		source: string,
		scope: StartupPackageUpdateScope,
		target: GitSemverTag,
		checkedAt: number,
	): string | undefined {
		try {
			this.state.write({ source, scope, checkedAt, targetHead: target.commit, targetTag: target.name });
			return undefined;
		} catch (error) {
			return `Remote check succeeded, but freshness state could not be saved: ${describeError(error)}`;
		}
	}

	private async replaceCheckout(
		source: GitSource,
		installedPath: string,
		target: GitSemverTag,
	): Promise<string | undefined> {
		const parent = dirname(installedPath);
		const base = basename(installedPath);
		const stagingPath = join(parent, `.${base}.startup-stage-${randomUUID()}`);
		const backupPath = join(parent, `.${base}.startup-backup-${randomUUID()}`);
		let originalMoved = false;
		let replacementInstalled = false;
		let phase: StartupPackageUpdatePhase = "prepare";

		try {
			await this.operations.prepareCheckout(source, target, stagingPath);
			const stagedHead = await this.operations.getHead(stagingPath);
			if (stagedHead !== target.commit || (await this.operations.checkoutHasChanges(stagingPath))) {
				throw new Error(`Prepared Git package did not verify at ${target.name}`);
			}

			phase = "apply";
			// Update writers are locked and staging is complete, but these rollback-capable renames are not
			// atomic for readers. Removing that brief path transition requires a versioned checkout pointer.
			renameSync(installedPath, backupPath);
			originalMoved = true;
			renameSync(stagingPath, installedPath);
			replacementInstalled = true;

			try {
				rmSync(backupPath, { recursive: true, force: true });
				originalMoved = false;
				return undefined;
			} catch (error) {
				originalMoved = false;
				return `Package updated, but its backup at ${backupPath} could not be removed: ${describeError(error)}`;
			}
		} catch (error) {
			if (originalMoved && !replacementInstalled) {
				if (!existsSync(installedPath) && existsSync(backupPath)) {
					try {
						renameSync(backupPath, installedPath);
						originalMoved = false;
					} catch (rollbackError) {
						throw withPhase(
							new Error(
								`Could not apply the prepared package (${describeError(error)}); the previous checkout remains at ${backupPath}, but restoring it also failed (${describeError(rollbackError)})`,
							),
							"apply",
						);
					}
				} else {
					throw withPhase(
						new Error(
							`Could not apply the prepared package (${describeError(error)}); the previous checkout remains at ${backupPath}`,
						),
						"apply",
					);
				}
			}
			throw withPhase(error, phase);
		} finally {
			if (!replacementInstalled && existsSync(stagingPath)) {
				try {
					rmSync(stagingPath, { recursive: true, force: true });
				} catch {
					// Preserve the primary preparation or rollback result.
				}
			}
			if (!originalMoved && !replacementInstalled && existsSync(backupPath)) {
				try {
					rmSync(backupPath, { recursive: true, force: true });
				} catch {
					// Preserve the primary rollback result.
				}
			}
		}
	}
}
