import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

function roles(messages: AgentMessage[]): string[] {
	return messages.map((message) => message.role);
}

describe("#8537 custom messages injected during tool execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("appends the message after the turn's tool results instead of between call and result", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				// A background task (e.g. a subagent reply) notifies the session while the
				// tool is still running.
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(roles(harness.session.messages)).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
	});

	it("keeps session entries and message events in the same order as agent state", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const renderedCustomEntryIds: string[] = [];
		harness.session.subscribe((event) => {
			if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "custom") {
				const context = harness.session.getMessageRenderContext(event.message);
				if (!context?.entryId) throw new Error("Custom message emitted without canonical entry context");
				expect(context).toEqual({ entryId: context.entryId });
				const entry = harness.sessionManager.getEntry(context.entryId);
				expect(entry?.type).toBe("custom_message");
				renderedCustomEntryIds.push(context.entryId);
			}
		});

		await harness.session.prompt("hi");
		expect(renderedCustomEntryIds).toHaveLength(2);
		expect(renderedCustomEntryIds[0]).toBe(renderedCustomEntryIds[1]);

		const entryKinds = harness.sessionManager
			.getBranch()
			.flatMap((entry) =>
				entry.type === "message" ? [entry.message.role] : entry.type === "custom_message" ? ["custom"] : [],
			);
		expect(entryKinds).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);

		// message events must never describe a message the session tree does not contain yet
		const messageStarts = harness.events.flatMap((event) =>
			event.type === "message_start" ? [event.message.role] : [],
		);
		expect(messageStarts).toEqual(["user", "assistant", "toolResult", "custom", "assistant"]);
	});

	it("flushes agent_end context onto the outgoing branch before terminal navigation", async () => {
		let targetId: string | undefined;
		let outgoingLeafId: string | null = null;
		let commandSawCustom = false;
		let navigated = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", (_event, ctx) => {
						if (!targetId) return;
						outgoingLeafId = ctx.sessionManager.getLeafId();
						pi.sendMessage(
							{ customType: "outgoing-context", content: "old branch context", display: true },
							{ triggerTurn: false },
						);
						ctx.queueCommand("return-to-target", "", { terminal: true });
					});
					pi.registerCommand("return-to-target", {
						description: "Navigate after queued context is saved",
						handler: async (_args, ctx) => {
							commandSawCustom = ctx.sessionManager
								.getBranch()
								.some((entry) => entry.type === "custom_message" && entry.customType === "outgoing-context");
							if (!targetId) throw new Error("Missing navigation target");
							const result = await harness.session.navigateTree(targetId);
							navigated = !result.cancelled;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("baseline"), fauxAssistantMessage("outgoing response")]);
		await harness.session.prompt("first");
		targetId = harness.sessionManager.getLeafId() ?? undefined;
		expect(targetId).toBeDefined();
		await harness.session.prompt("second");
		await harness.session.waitForIdle();

		expect(commandSawCustom).toBe(true);
		expect(navigated).toBe(true);
		const customEntries = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "outgoing-context");
		expect(customEntries).toHaveLength(1);
		expect(customEntries[0]?.parentId).toBe(outgoingLeafId);
		expect(harness.sessionManager.getLeafId()).toBe(targetId);
		expect(harness.sessionManager.getBranch().some((entry) => entry.id === customEntries[0]?.id)).toBe(false);
	});

	it("produces an llm history where every tool result follows its tool call", async () => {
		let notify: (() => Promise<void>) | undefined;
		const slowTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for a background task",
			parameters: Type.Object({}),
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};

		const harness = await createHarness({ tools: [slowTool] });
		harnesses.push(harness);
		notify = () =>
			harness.session.sendCustomMessage(
				{ customType: "subagent-reply", content: "subagent replied", display: true },
				{ triggerTurn: false },
			);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("second turn"),
		]);

		await harness.session.prompt("hi");
		await harness.session.prompt("and now?");

		const llmMessages = convertToLlm(harness.session.messages);
		const openToolCallIds = new Set<string>();
		for (const message of llmMessages) {
			if (message.role === "assistant") {
				openToolCallIds.clear();
				for (const block of message.content) {
					if (block.type === "toolCall") openToolCallIds.add(block.id);
				}
				continue;
			}
			if (message.role === "toolResult") {
				expect(openToolCallIds.has(message.toolCallId)).toBe(true);
				openToolCallIds.delete(message.toolCallId);
				continue;
			}
			openToolCallIds.clear();
		}
	});
});
