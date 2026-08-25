import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionMessageEntry } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function persistedMessages(harness: Harness): SessionMessageEntry[] {
	return harness.sessionManager.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");
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

	it("keeps steering input and all assistant and tool entries in the active agent segment", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, releaseTool } = waiting;
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("steering handled"),
		]);

		const promptPromise = harness.session.prompt("start");
		await waitForToolStart;
		await harness.session.steer("change course");
		releaseTool();
		await promptPromise;

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
	});
});
