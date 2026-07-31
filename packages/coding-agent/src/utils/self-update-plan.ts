import type { LatestPiRelease } from "./version-check.ts";
import { isNewerPackageVersion } from "./version-check.ts";

export type SelfUpdatePlan =
	| { kind: "none" }
	| { kind: "external"; url: string; version: string; note?: string }
	| { kind: "package"; packageName: string; installSpec: string; version: string; note?: string };

export function createSelfUpdatePlan(options: {
	currentPackageName: string;
	currentVersion: string;
	force: boolean;
	latestRelease: LatestPiRelease;
}): SelfUpdatePlan {
	const { currentPackageName, currentVersion, force, latestRelease } = options;
	const newer = isNewerPackageVersion(latestRelease.version, currentVersion);
	if (latestRelease.selfUpdate.kind === "external") {
		if (!force && !newer) return { kind: "none" };
		return {
			kind: "external",
			url: latestRelease.selfUpdate.url,
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
		};
	}

	const packageName = latestRelease.selfUpdate.packageName ?? currentPackageName;
	if (!force && packageName === currentPackageName && !newer) return { kind: "none" };
	return {
		kind: "package",
		packageName,
		installSpec: `${packageName}@${latestRelease.version}`,
		version: latestRelease.version,
		...(latestRelease.note ? { note: latestRelease.note } : {}),
	};
}
