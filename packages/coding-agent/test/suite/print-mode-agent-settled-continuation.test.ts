import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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
				modelRuntime: harness.modelRuntime,
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

	it.each(["text", "json"] as const)(
		"runs terminal queued navigation before an agent_settled continuation in %s mode",
		async (mode) => {
			const summary = "Abandoned print-mode branch summarized exactly.";
			let harness: Harness | undefined;
			let anchorId: string | undefined;
			let navigationCompleted = false;
			let continuationSent = false;
			let commandSawIdle: boolean | undefined;
			let sessionWasGloballyBusy: boolean | undefined;

			harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "queue_navigation_test",
							label: "Queue Navigation Test",
							description: "Queue terminal session-tree navigation after the current turn.",
							parameters: Type.Object({}),
							execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
								ctx.queueCommand("navigate-after-turn", "", { terminal: true });
								return {
									content: [{ type: "text", text: "queued navigation" }],
									details: {},
								};
							},
						});
						pi.registerCommand("navigate-after-turn", {
							description: "Navigate to the test anchor after the turn.",
							handler: async (_args, ctx) => {
								if (!anchorId || !harness) throw new Error("Missing navigation test state");
								commandSawIdle = ctx.isIdle();
								sessionWasGloballyBusy = harness.session.isStreaming;
								const result = await ctx.navigateTree(anchorId, { summary: { summary } });
								navigationCompleted = !result.cancelled;
							},
						});
						pi.on("agent_settled", () => {
							if (!navigationCompleted || continuationSent) return;
							continuationSent = true;
							pi.sendUserMessage("continue after navigation", { deliverAs: "followUp" });
						});
					},
				],
			});
			harnesses.push(harness);

			harness.setResponses([fauxAssistantMessage("anchor response")]);
			await harness.session.prompt("anchor");
			anchorId = harness.sessionManager.getLeafId() ?? undefined;

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("queue_navigation_test", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage("old branch response"),
				fauxAssistantMessage("continued response"),
			]);

			const services = await createAgentSessionServices({
				cwd: harness.tempDir,
				agentDir: harness.tempDir,
				modelRuntime: harness.modelRuntime,
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
			expect(commandSawIdle).toBe(true);
			expect(sessionWasGloballyBusy).toBe(true);
			expect(navigationCompleted).toBe(true);
			expect(getUserTexts(harness)).toEqual(["anchor", "continue after navigation"]);
			expect(getAssistantTexts(harness)).toEqual(["anchor response", "continued response"]);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "branch_summary" && entry.summary === summary),
			).toBe(true);
			if (mode === "text") {
				expect(printOutput).toEqual(["continued response\n"]);
			} else {
				const output = printOutput.join("");
				expect(output).toContain('"text":"continued response"');
			}
		},
	);
});
