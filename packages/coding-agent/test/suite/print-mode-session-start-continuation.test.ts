import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: vi.fn(),
}));

describe("print mode session_start continuation", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each(["text", "json"] as const)("waits for a session_start message in %s mode", async (mode) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.source === "extension") await new Promise((resolve) => setTimeout(resolve, 10));
					});
					pi.on("session_start", () => {
						pi.sendUserMessage("start from extension");
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("finished")]);
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
		});
		const runtime = new AgentSessionRuntime(harness.session, services, async () => {
			throw new Error("Unexpected session replacement");
		});

		expect(await runPrintMode(runtime, { mode })).toBe(0);
		expect(getUserTexts(harness)).toEqual(["start from extension"]);
		expect(getAssistantTexts(harness)).toEqual(["finished"]);
	});
});
