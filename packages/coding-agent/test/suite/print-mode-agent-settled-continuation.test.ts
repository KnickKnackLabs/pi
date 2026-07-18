import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../../src/core/agent-session-services.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.ts";

const printOutput = vi.hoisted(() => [] as string[]);

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	writeRawStdout: (text: string) => {
		printOutput.push(text);
	},
}));

describe("print mode extension continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		printOutput.length = 0;
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each(["text", "json"] as const)(
		"waits for a user turn started by an agent_settled extension handler in %s mode",
		async (mode) => {
			let continuationSent = false;
			const idleStatesAfterSend: boolean[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("input", async (event) => {
							if (event.source === "extension") {
								await new Promise((resolve) => setTimeout(resolve, 10));
							}
						});
						pi.on("agent_settled", (_event, ctx) => {
							if (continuationSent) return;
							continuationSent = true;
							pi.sendUserMessage("continue from extension");
							idleStatesAfterSend.push(ctx.isIdle());
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

			const services = await createAgentSessionServices({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				authStorage: harness.authStorage,
				settingsManager: harness.settingsManager,
			});
			const runtime = new AgentSessionRuntime(harness.session, services, async () => {
				throw new Error("Unexpected session replacement");
			});

			const exitCode = await runPrintMode(runtime, {
				mode,
				initialMessage: "start",
			});

			expect(exitCode).toBe(0);
			expect(getUserTexts(harness)).toEqual(["start", "continue from extension"]);
			expect(getAssistantTexts(harness)).toEqual(["first", "second"]);
			expect(idleStatesAfterSend).toEqual([false]);
			if (mode === "text") {
				expect(printOutput).toEqual(["second\n"]);
			} else {
				const output = printOutput.join("");
				expect(output).toContain('"text":"second"');
				expect(output).not.toContain('"stopReason":"aborted"');
			}
		},
	);
});
