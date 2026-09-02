import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSegmentCompletionEntry, SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function persistedMessages(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

function segmentCompletions(harness: Harness): AgentSegmentCompletionEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is AgentSegmentCompletionEntry => entry.type === "agent_segment_completion");
}

function providerMessageLabel(message: Message): string {
	if (message.role === "user") {
		return `user:${getMessageText(message)}`;
	}
	if (message.role === "toolResult") {
		return `toolResult:${message.toolName}:${getMessageText(message)}`;
	}
	const content = message.content
		.map((part) => {
			if (part.type === "toolCall") return `tool:${part.name}`;
			if (part.type === "thinking") return `thinking:${part.thinking}`;
			return part.text;
		})
		.join("|");
	return `assistant:${content}`;
}

async function createWaitingHarness(): Promise<{
	harness: Harness;
	waitForToolStart: Promise<void>;
	releaseTool: () => void;
}> {
	let releaseTool: (() => void) | undefined;
	const toolRelease = new Promise<void>((resolve) => {
		releaseTool = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for the test to release the tool",
		parameters: Type.Object({}),
		execute: async () => {
			await toolRelease;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	const waitForToolStart = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start" && event.toolName === "wait") {
				unsubscribe();
				resolve();
			}
		});
	});
	return { harness, waitForToolStart, releaseTool: () => releaseTool?.() };
}

describe("AgentSession persisted conversation segments", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("numbers a normal user input followed by one agent segment", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(persistedMessages(harness)).toMatchObject([
			{ segmentNumber: 1, segmentKind: "user", inputKind: "normal", message: { role: "user" } },
			{ segmentNumber: 2, segmentKind: "agent", message: { role: "assistant" } },
		]);
	});

	it("persists completion before agent_settled and emits it once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const order: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "entry_appended" && event.entry.type === "agent_segment_completion") {
				order.push("completion");
			}
			if (event.type === "agent_settled") {
				order.push("settled");
			}
		});
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(order).toEqual(["completion", "settled"]);
		expect(segmentCompletions(harness)).toEqual([
			expect.objectContaining({
				type: "agent_segment_completion",
				segmentNumber: 2,
				segmentKind: "agent",
				startedAt: expect.any(Number),
				endedAt: expect.any(Number),
				retryCount: 0,
			}),
		]);
		expect(segmentCompletions(harness)[0]?.endedAt).toBeGreaterThanOrEqual(
			segmentCompletions(harness)[0]?.startedAt ?? Number.POSITIVE_INFINITY,
		);
	});

	it("persists completion before draining a terminal queued command", async () => {
		let observedAtCommand: AgentSegmentCompletionEntry[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("observe-completion", {
						handler: (_args, ctx) => {
							observedAtCommand = ctx.sessionManager
								.getBranch()
								.filter(
									(entry): entry is AgentSegmentCompletionEntry => entry.type === "agent_segment_completion",
								);
						},
					});
					pi.on("message_end", (event, ctx) => {
						if (event.message.role === "assistant") {
							ctx.queueCommand("observe-completion", "", { terminal: true });
						}
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(observedAtCommand).toEqual([
			expect.objectContaining({ segmentNumber: 2, segmentKind: "agent", retryCount: 0 }),
		]);
		expect(segmentCompletions(harness)).toHaveLength(1);
	});

	it("supports stable context-only segment boundaries across tool follow-up and settlement", async () => {
		const projectedCalls: string[][] = [];
		const provenanceCalls: Array<Array<{ marker: boolean; hasContext: boolean }>> = [];
		const activeSegments: Array<number | undefined> = [];
		const inspectTool: AgentTool = {
			name: "inspect",
			label: "Inspect",
			description: "Return one deterministic proof result",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "observed" }],
				details: {},
			}),
		};
		const harness = await createHarness({
			tools: [inspectTool],
			extensionFactories: [
				(pi) => {
					const marker = (segmentNumber: number, edge: "starts" | "ends"): AgentMessage => ({
						role: "custom",
						customType: "segment-boundary-proof",
						content: `[segment ${segmentNumber} ${edge}]`,
						display: false,
						timestamp: segmentNumber,
					});
					pi.on("context", (event, ctx) => {
						const completed = new Set(
							ctx.sessionManager
								.getBranch()
								.filter(
									(entry): entry is AgentSegmentCompletionEntry => entry.type === "agent_segment_completion",
								)
								.map((entry) => entry.segmentNumber),
						);
						const projected: AgentMessage[] = [];
						let openAgentSegment: number | undefined;
						const closeCompletedAgent = () => {
							if (openAgentSegment !== undefined && completed.has(openAgentSegment)) {
								projected.push(marker(openAgentSegment, "ends"));
								openAgentSegment = undefined;
							}
						};

						for (const message of event.messages) {
							const source = event.getMessageContext(message);
							if (source?.segmentNumber === undefined || source.segmentKind === undefined) {
								projected.push(message);
								continue;
							}
							if (source.segmentKind === "user") {
								closeCompletedAgent();
								projected.push(
									marker(source.segmentNumber, "starts"),
									message,
									marker(source.segmentNumber, "ends"),
								);
								continue;
							}
							if (openAgentSegment !== source.segmentNumber) {
								closeCompletedAgent();
								openAgentSegment = source.segmentNumber;
								projected.push(marker(source.segmentNumber, "starts"));
							}
							projected.push(message);
						}
						closeCompletedAgent();

						const activeSegment = event.activeAgentSegment?.renderContext?.segmentNumber;
						if (activeSegment !== undefined && activeSegment !== openAgentSegment) {
							projected.push(marker(activeSegment, "starts"));
						}
						return { messages: projected };
					});
					pi.on("context", (event) => {
						provenanceCalls.push(
							event.messages.map((message) => ({
								marker: message.role === "custom" && message.customType === "segment-boundary-proof",
								hasContext: event.getMessageContext(message) !== undefined,
							})),
						);
						activeSegments.push(event.activeAgentSegment?.renderContext?.segmentNumber);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				projectedCalls.push(context.messages.map(providerMessageLabel));
				return fauxAssistantMessage(fauxToolCall("inspect", {}, { id: "inspect-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				projectedCalls.push(context.messages.map(providerMessageLabel));
				return fauxAssistantMessage("first complete");
			},
			(context) => {
				projectedCalls.push(context.messages.map(providerMessageLabel));
				return fauxAssistantMessage("second complete");
			},
		]);

		await harness.session.prompt("first");
		await harness.session.prompt("second");

		expect(projectedCalls).toEqual([
			["user:[segment 1 starts]", "user:first", "user:[segment 1 ends]", "user:[segment 2 starts]"],
			[
				"user:[segment 1 starts]",
				"user:first",
				"user:[segment 1 ends]",
				"user:[segment 2 starts]",
				"assistant:tool:inspect",
				"toolResult:inspect:observed",
			],
			[
				"user:[segment 1 starts]",
				"user:first",
				"user:[segment 1 ends]",
				"user:[segment 2 starts]",
				"assistant:tool:inspect",
				"toolResult:inspect:observed",
				"assistant:first complete",
				"user:[segment 2 ends]",
				"user:[segment 3 starts]",
				"user:second",
				"user:[segment 3 ends]",
				"user:[segment 4 starts]",
			],
		]);
		expect(projectedCalls[2]?.slice(0, projectedCalls[1]?.length)).toEqual(projectedCalls[1]);
		expect(projectedCalls[2]?.slice(projectedCalls[1]?.length, projectedCalls[1]?.length + 2)).toEqual([
			"assistant:first complete",
			"user:[segment 2 ends]",
		]);
		expect(activeSegments).toEqual([2, 2, 4]);
		for (const call of provenanceCalls) {
			for (const message of call) {
				expect(message.hasContext).toBe(!message.marker);
			}
		}
	});

	it("allocates the Agent segment before the initial agent_start event", async () => {
		const starts: Array<{
			segmentNumber?: number;
			segmentKind?: string;
			segmentStartedAt?: number;
			segmentRetryCount?: number;
		}> = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", (event) => {
						starts.push({
							segmentNumber: event.renderContext?.segmentNumber,
							segmentKind: event.renderContext?.segmentKind,
							segmentStartedAt: event.segmentStartedAt,
							segmentRetryCount: event.segmentRetryCount,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(starts).toEqual([
			{
				segmentNumber: 2,
				segmentKind: "agent",
				segmentStartedAt: expect.any(Number),
				segmentRetryCount: 0,
			},
		]);
		expect(persistedMessages(harness)).toMatchObject([
			{ segmentNumber: 1, segmentKind: "user", inputKind: "normal", message: { role: "user" } },
			{ segmentNumber: 2, segmentKind: "agent", message: { role: "assistant" } },
		]);
	});

	it("exposes canonical persisted renderer context when public message_end fires", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const observed: Array<{
			role: AgentMessage["role"];
			entryId?: string;
			segmentNumber?: number;
			segmentKind?: string;
			inputKind?: string;
			persistedType?: string;
			persistedRole?: AgentMessage["role"];
		}> = [];
		harness.session.subscribe((event) => {
			if (event.type !== "message_end") return;
			const context = harness.session.getMessageRenderContext(event.message);
			const entry = context?.entryId ? harness.sessionManager.getEntry(context.entryId) : undefined;
			observed.push({
				role: event.message.role,
				...context,
				persistedType: entry?.type,
				persistedRole: entry?.type === "message" ? entry.message.role : undefined,
			});
		});
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");
		await harness.session.sendCustomMessage({
			customType: "notice",
			content: "custom",
			display: true,
		});

		expect(observed).toMatchObject([
			{
				role: "user",
				entryId: expect.any(String),
				segmentNumber: 1,
				segmentKind: "user",
				inputKind: "normal",
				persistedRole: "user",
			},
			{
				role: "assistant",
				entryId: expect.any(String),
				segmentNumber: 2,
				segmentKind: "agent",
				persistedType: "message",
				persistedRole: "assistant",
			},
			{
				role: "custom",
				entryId: expect.any(String),
				persistedType: "custom_message",
			},
		]);
	});

	it("keeps automatic retries in one Agent segment and reports only resumed attempts", async () => {
		const assistantRuntime: Array<{
			segmentNumber?: number;
			segmentStartedAt?: number;
			segmentRetryCount?: number;
		}> = [];
		const settledRuntime: Array<{
			segmentNumber?: number;
			segmentStartedAt?: number;
			segmentRetryCount?: number;
		}> = [];
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("message_start", (event) => {
						if (event.message.role !== "assistant") return;
						assistantRuntime.push({
							segmentNumber: event.renderContext?.segmentNumber,
							segmentStartedAt: event.segmentStartedAt,
							segmentRetryCount: event.segmentRetryCount,
						});
					});
					pi.on("agent_settled", (event) => {
						settledRuntime.push({
							segmentNumber: event.renderContext?.segmentNumber,
							segmentStartedAt: event.segmentStartedAt,
							segmentRetryCount: event.segmentRetryCount,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("retry once");

		expect(
			persistedMessages(harness)
				.filter((entry) => entry.message.role === "assistant")
				.map((entry) => entry.segmentNumber),
		).toEqual([2, 2]);
		expect(assistantRuntime).toEqual([
			{
				segmentNumber: 2,
				segmentStartedAt: expect.any(Number),
				segmentRetryCount: 0,
			},
			{
				segmentNumber: 2,
				segmentStartedAt: assistantRuntime[0]?.segmentStartedAt,
				segmentRetryCount: 1,
			},
		]);
		expect(settledRuntime).toEqual([
			{
				segmentNumber: 2,
				segmentStartedAt: assistantRuntime[0]?.segmentStartedAt,
				segmentRetryCount: 1,
			},
		]);
		expect(segmentCompletions(harness)).toMatchObject([{ segmentNumber: 2, retryCount: 1 }]);
	});

	it("reports zero retries when a terminal error never resumes", async () => {
		const settledRetryCounts: Array<number | undefined> = [];
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
			extensionFactories: [
				(pi) => {
					pi.on("agent_settled", (event) => {
						settledRetryCounts.push(event.segmentRetryCount);
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_request_error" })]);

		await harness.session.prompt("do not retry");

		expect(settledRetryCounts).toEqual([0]);
		expect(
			persistedMessages(harness)
				.filter((entry) => entry.message.role === "assistant")
				.map((entry) => entry.segmentNumber),
		).toEqual([2]);
		expect(segmentCompletions(harness)).toMatchObject([{ segmentNumber: 2, retryCount: 0 }]);
	});

	it("keeps steering input and all assistant and tool entries in the active agent segment", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, releaseTool } = waiting;
		harnesses.push(harness);
		const liveUserContexts: Array<{
			text: string;
			entryId?: string;
			segmentNumber?: number;
			segmentKind?: string;
			inputKind?: string;
		}> = [];
		harness.session.subscribe((event) => {
			if (event.type !== "message_start" || event.message.role !== "user") return;
			liveUserContexts.push({
				text: getMessageText(event.message),
				...harness.session.getMessageRenderContext(event.message),
			});
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steering handled"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.steer("change course");
		releaseTool();
		await promptPromise;

		expect(liveUserContexts).toEqual([
			{
				text: "start",
				segmentNumber: 1,
				segmentKind: "user",
				inputKind: "normal",
			},
			{
				text: "change course",
				segmentNumber: 2,
				segmentKind: "agent",
				inputKind: "steer",
			},
		]);

		const entries = persistedMessages(harness);
		const initialUser = entries.find((entry) => getMessageText(entry.message) === "start");
		const steering = entries.find((entry) => getMessageText(entry.message) === "change course");
		expect(initialUser).toMatchObject({ segmentNumber: 1, segmentKind: "user", inputKind: "normal" });
		expect(steering).toMatchObject({ segmentNumber: 2, segmentKind: "agent", inputKind: "steer" });
		for (const entry of entries.filter(
			(entry) => entry.message.role === "assistant" || entry.message.role === "toolResult",
		)) {
			expect(entry).toMatchObject({ segmentNumber: 2, segmentKind: "agent" });
		}
	});

	it("alternates delivered follow-ups and agent segments in one-at-a-time mode", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, releaseTool } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original complete"),
			fauxAssistantMessage("first complete"),
			fauxAssistantMessage("second complete"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.followUp("follow-up one");
		await harness.session.followUp("follow-up two");
		releaseTool();
		await promptPromise;

		const entries = persistedMessages(harness);
		const users = entries.filter((entry) => entry.message.role === "user");
		expect(
			users.map((entry) => [getMessageText(entry.message), entry.segmentNumber, entry.segmentKind, entry.inputKind]),
		).toEqual([
			["start", 1, "user", "normal"],
			["follow-up one", 3, "user", "follow-up"],
			["follow-up two", 5, "user", "follow-up"],
		]);
		const assistantSegments = entries
			.filter((entry) => entry.message.role === "assistant")
			.map((entry) => entry.segmentNumber);
		expect(assistantSegments).toEqual([2, 2, 4, 6]);
		expect(entries.find((entry) => entry.message.role === "toolResult")).toMatchObject({
			segmentNumber: 2,
			segmentKind: "agent",
		});
		expect(segmentCompletions(harness).map((entry) => entry.segmentNumber)).toEqual([2, 4, 6]);
	});

	it("numbers batched follow-ups individually before one shared agent segment", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, releaseTool } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original complete"),
			fauxAssistantMessage("batch complete"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.followUp("follow-up one");
		await harness.session.followUp("follow-up two");
		releaseTool();
		await promptPromise;

		const entries = persistedMessages(harness);
		const users = entries.filter((entry) => entry.message.role === "user");
		expect(
			users.map((entry) => [getMessageText(entry.message), entry.segmentNumber, entry.segmentKind, entry.inputKind]),
		).toEqual([
			["start", 1, "user", "normal"],
			["follow-up one", 3, "user", "follow-up"],
			["follow-up two", 4, "user", "follow-up"],
		]);
		const assistantSegments = entries
			.filter((entry) => entry.message.role === "assistant")
			.map((entry) => entry.segmentNumber);
		expect(assistantSegments).toEqual([2, 2, 5]);
		expect(segmentCompletions(harness).map((entry) => entry.segmentNumber)).toEqual([2, 5]);
	});
});
