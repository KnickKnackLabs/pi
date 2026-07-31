import { describe, expect, it } from "vitest";
import {
	classifyGitRef,
	isGitTagCompatible,
	parseRemoteGitTags,
	selectLatestCompatibleGitTag,
} from "../src/utils/git-semver.ts";

describe("Git SemVer streams", () => {
	it("keeps ordinary refs exact and recognizes only explicit operator ranges", () => {
		expect(classifyGitRef(undefined)).toEqual({ kind: "none" });
		expect(classifyGitRef("v0.4.0")).toEqual({ kind: "exact", ref: "v0.4.0" });
		expect(classifyGitRef("0.4")).toEqual({ kind: "exact", ref: "0.4" });
		expect(classifyGitRef("release/0.4")).toEqual({ kind: "exact", ref: "release/0.4" });
		expect(classifyGitRef("~0.4.0")).toMatchObject({ kind: "range" });
		expect(classifyGitRef("^0.4.0")).toMatchObject({ kind: "range" });
		expect(classifyGitRef("~not-a-version")).toBeNull();
	});

	it("parses lightweight and annotated remote tags and selects the newest compatible release", () => {
		const tags = parseRemoteGitTags(
			[
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v0.4.0",
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v0.4.0^{}",
				"cccccccccccccccccccccccccccccccccccccccc\trefs/tags/0.4.1",
				"dddddddddddddddddddddddddddddddddddddddd\trefs/tags/v0.5.0",
				"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\trefs/tags/not-semver",
			].join("\n"),
		);

		expect(tags).toEqual([
			{
				name: "v0.4.0",
				version: "0.4.0",
				object: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
			{
				name: "0.4.1",
				version: "0.4.1",
				object: "cccccccccccccccccccccccccccccccccccccccc",
				commit: "cccccccccccccccccccccccccccccccccccccccc",
			},
			{
				name: "v0.5.0",
				version: "0.5.0",
				object: "dddddddddddddddddddddddddddddddddddddddd",
				commit: "dddddddddddddddddddddddddddddddddddddddd",
			},
		]);
		expect(selectLatestCompatibleGitTag(tags, "~0.4.0")?.name).toBe("0.4.1");
	});

	it("uses SemVer prerelease rules", () => {
		expect(isGitTagCompatible("v0.4.1-beta.1", "~0.4.0")).toBe(false);
		expect(isGitTagCompatible("v0.4.1-beta.1", ">=0.4.1-beta.1 <0.5.0")).toBe(true);
	});

	it("breaks equivalent-version tag ties deterministically", () => {
		const tags = parseRemoteGitTags(
			[
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v0.4.1",
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/0.4.1",
			].join("\n"),
		);
		expect(selectLatestCompatibleGitTag(tags, "~0.4.0")?.name).toBe("0.4.1");
	});
});
