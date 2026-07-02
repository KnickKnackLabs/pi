import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

type UserMessageEntry = Extract<SessionEntry, { type: "message" }> & {
	message: Extract<AgentMessage, { role: "user" }>;
};

function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
	return entry.type === "message" && entry.message.role === "user";
}

describe("queued extension commands", () => {
	let session: AgentSession | undefined;
	let tempDir: string | undefined;

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		}
	});

	it("lets tools queue real extension commands after the current turn", async () => {
		tempDir = join(tmpdir(), `pi-queued-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		let queuedCommandRan = false;
		let queuedCommandArgs: string | undefined;
		let commandSawIdle: boolean | undefined;

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "queue_command_test",
					label: "Queue Command Test",
					description: "Queue a test extension command after the turn.",
					parameters: Type.Object({}),
					execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
						ctx.queueCommand("mark-queued-command", "from-tool");
						return {
							content: [{ type: "text", text: "queued command" }],
							details: {},
						};
					},
				});
				pi.registerCommand("mark-queued-command", {
					description: "Mark that a queued command ran.",
					handler: async (args, ctx) => {
						queuedCommandRan = true;
						queuedCommandArgs = args;
						commandSawIdle = ctx.isIdle();
					},
				});
			},
		]);

		let streamCall = 0;
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			streamFn: () => {
				streamCall += 1;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (streamCall === 1) {
						stream.push({
							type: "done",
							reason: "toolUse",
							message: assistantMessage(
								[
									{
										type: "toolCall",
										id: "tool-call-1",
										name: "queue_command_test",
										arguments: {},
									},
								],
								"toolUse",
							),
						});
						return;
					}
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage([{ type: "text", text: "final" }], "stop"),
					});
				});
				return stream;
			},
			initialState: {
				model,
				systemPrompt: "test",
				tools: [],
			},
		});

		const sessionManager = SessionManager.create(tempDir);
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const resourceLoader = createTestResourceLoader({ extensionsResult });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader,
		});
		session.subscribe(() => {});

		await session.prompt("start");

		expect(queuedCommandRan).toBe(true);
		expect(queuedCommandArgs).toBe("from-tool");
		expect(commandSawIdle).toBe(true);
		expect(session.pendingMessageCount).toBe(0);

		const userMessages = sessionManager
			.getEntries()
			.filter(isUserMessageEntry)
			.map((entry) =>
				typeof entry.message.content === "string"
					? entry.message.content
					: entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			);
		expect(userMessages).toEqual(["start"]);
	});
});
