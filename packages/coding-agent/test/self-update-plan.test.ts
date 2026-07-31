import { describe, expect, it } from "vitest";
import { createSelfUpdatePlan } from "../src/utils/self-update-plan.ts";

const currentPackageName = "@earendil-works/pi-coding-agent";

describe("self-update plans", () => {
	it("keeps a current package release installed", () => {
		expect(
			createSelfUpdatePlan({
				currentPackageName,
				currentVersion: "1.2.3",
				force: false,
				latestRelease: {
					version: "1.2.3",
					selfUpdate: { kind: "package" },
					details: { label: "Changelog", url: "https://pi.dev/changelog" },
				},
			}),
		).toEqual({ kind: "none" });
	});

	it("prepares the release channel's package target", () => {
		expect(
			createSelfUpdatePlan({
				currentPackageName,
				currentVersion: "1.2.3",
				force: false,
				latestRelease: {
					version: "1.2.4",
					selfUpdate: { kind: "package", packageName: "@new-scope/pi" },
					details: { label: "Changelog", url: "https://pi.dev/changelog" },
				},
			}),
		).toEqual({
			kind: "package",
			packageName: "@new-scope/pi",
			installSpec: "@new-scope/pi@1.2.4",
			version: "1.2.4",
		});
	});

	it("migrates a renamed package even when its version is lower", () => {
		expect(
			createSelfUpdatePlan({
				currentPackageName,
				currentVersion: "2.0.0",
				force: false,
				latestRelease: {
					version: "1.0.0",
					selfUpdate: { kind: "package", packageName: "@new-scope/pi" },
					details: { label: "Changelog", url: "https://pi.dev/changelog" },
				},
			}),
		).toEqual({
			kind: "package",
			packageName: "@new-scope/pi",
			installSpec: "@new-scope/pi@1.0.0",
			version: "1.0.0",
		});
	});

	it("keeps KKL releases outside package self-update", () => {
		const releaseUrl = "https://github.com/KnickKnackLabs/pi/releases/tag/v0.83.0-kkl.2";
		expect(
			createSelfUpdatePlan({
				currentPackageName,
				currentVersion: "0.83.0-kkl.1",
				force: false,
				latestRelease: {
					version: "0.83.0-kkl.2",
					selfUpdate: { kind: "external", url: releaseUrl },
					details: { label: "Release", url: releaseUrl },
				},
			}),
		).toEqual({ kind: "external", url: releaseUrl, version: "0.83.0-kkl.2" });
	});
});
