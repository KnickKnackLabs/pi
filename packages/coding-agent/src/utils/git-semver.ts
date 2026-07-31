import { rcompare, satisfies, valid, validRange } from "semver";

export type GitRefSpec = { kind: "none" } | { kind: "exact"; ref: string } | { kind: "range"; range: string };

export interface GitSemverTag {
	name: string;
	version: string;
	object: string;
	commit: string;
}

/**
 * Only operator-prefixed ranges are streams. Bare versions remain exact Git
 * refs, preserving the existing package-source contract.
 */
export function classifyGitRef(ref: string | undefined): GitRefSpec | null {
	if (!ref) return { kind: "none" };
	if (!ref.startsWith("~") && !ref.startsWith("^")) {
		return { kind: "exact", ref };
	}
	const range = validRange(ref);
	return range ? { kind: "range", range } : null;
}

export function isGitTagCompatible(name: string, range: string): boolean {
	const version = valid(name);
	return version !== null && satisfies(version, range);
}

export function selectLatestCompatibleGitTag(tags: GitSemverTag[], range: string): GitSemverTag | undefined {
	return tags
		.filter((tag) => satisfies(tag.version, range))
		.sort((a, b) => rcompare(a.version, b.version) || a.name.localeCompare(b.name))[0];
}

/** Parse `git ls-remote --tags` output, peeling annotated tags to commits. */
export function parseRemoteGitTags(output: string): GitSemverTag[] {
	const refs = new Map<string, { object?: string; commit?: string }>();
	for (const line of output.split("\n")) {
		const match = line.match(/^([0-9a-fA-F]+)\s+refs\/tags\/(.+)$/);
		if (!match) continue;
		const object = match[1];
		const rawName = match[2];
		if (!object || !rawName) continue;

		const peeled = rawName.endsWith("^{}");
		const name = peeled ? rawName.slice(0, -3) : rawName;
		const entry = refs.get(name) ?? {};
		if (peeled) entry.commit = object;
		else entry.object = object;
		refs.set(name, entry);
	}

	const tags: GitSemverTag[] = [];
	for (const [name, entry] of refs) {
		const version = valid(name);
		if (!version || !entry.object) continue;
		tags.push({
			name,
			version,
			object: entry.object,
			commit: entry.commit ?? entry.object,
		});
	}
	return tags;
}
