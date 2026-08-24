import { clean, compare, prerelease, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const UPSTREAM_LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const UPSTREAM_CHANGELOG_URL = "https://pi.dev/changelog";
const KKL_LATEST_RELEASE_URL = "https://api.github.com/repos/KnickKnackLabs/pi/releases/latest";
const KKL_RELEASES_URL = "https://github.com/KnickKnackLabs/pi/releases";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export type PiReleaseChannel = "auto" | "upstream" | "kkl";

export type PiSelfUpdateTarget = { kind: "package"; packageName?: string } | { kind: "external"; url: string };

export interface LatestPiRelease {
	version: string;
	selfUpdate: PiSelfUpdateTarget;
	details: { label: "Changelog" | "Release"; url: string };
	note?: string;
}

interface VersionCheckOptions {
	timeoutMs?: number;
	channel?: PiReleaseChannel;
	retry?: boolean;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export function isKklVersion(version: string): boolean {
	return prerelease(version.trim())?.[0] === "kkl";
}

function resolveReleaseChannel(currentVersion: string, channel: PiReleaseChannel): Exclude<PiReleaseChannel, "auto"> {
	if (channel !== "auto") return channel;
	return isKklVersion(currentVersion) ? "kkl" : "upstream";
}

async function getLatestUpstreamRelease(
	currentVersion: string,
	timeoutMs: number,
	retry: boolean,
): Promise<LatestPiRelease | undefined> {
	const response = await fetchWithRetry(
		UPSTREAM_LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{ maxRetries: retry ? 2 : 0, timeoutMs },
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		selfUpdate: { kind: "package", ...(packageName ? { packageName } : {}) },
		details: { label: "Changelog", url: UPSTREAM_CHANGELOG_URL },
		...(note ? { note } : {}),
	};
}

async function getLatestKklRelease(
	currentVersion: string,
	timeoutMs: number,
	retry: boolean,
): Promise<LatestPiRelease | undefined> {
	const response = await fetchWithRetry(
		KKL_LATEST_RELEASE_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
		{ maxRetries: retry ? 2 : 0, timeoutMs },
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as { html_url?: unknown; tag_name?: unknown };
	if (typeof data.tag_name !== "string") return undefined;
	const version = clean(data.tag_name.trim());
	if (!version || !isKklVersion(version)) return undefined;
	const releaseUrl =
		typeof data.html_url === "string" && data.html_url.trim() ? data.html_url.trim() : KKL_RELEASES_URL;
	return {
		version,
		selfUpdate: { kind: "external", url: releaseUrl },
		details: { label: "Release", url: releaseUrl },
	};
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_OFFLINE) return undefined;

	const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
	const retry = options.retry ?? false;
	return resolveReleaseChannel(currentVersion, options.channel ?? "auto") === "kkl"
		? getLatestKklRelease(currentVersion, timeoutMs, retry)
		: getLatestUpstreamRelease(currentVersion, timeoutMs, retry);
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
