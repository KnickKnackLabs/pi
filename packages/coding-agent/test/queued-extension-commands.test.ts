import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function createSession(
	tempDir: string,
	content: AssistantMessage["content"],
	extensionsResult: Awaited<ReturnType<typeof createTestExtensionsResult>>,
): Promise<{ session: AgentSession; sessionManager: SessionManager }> {
	let streamCall = 0;
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const agent = new Agent({
		streamFunction: () => {
			streamCall += 1;
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				if (streamCall === 1) {
					stream.push({
						type: "done",
						reason: "toolUse",
						message: assistantMessage(content, "toolUse"),
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
	const authStorage = AuthStorage.inMemory({
		[model.provider]: { type: "api_key", key: "test-key" },
	});
	const modelRegistry = await createModelRegistry(authStorage);
	const resourceLoader = createTestResourceLoader({ extensionsResult });

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader,
	});
	session.subscribe(() => {});
	return { session, sessionManager };
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

	function makeTempDir(): string {
		const dir = join(tmpdir(), `pi-queued-command-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		tempDir = dir;
		return dir;
	}

	it("lets tools queue real extension commands after the current turn", async () => {
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

		const result = await createSession(
			makeTempDir(),
			[
				{
					type: "toolCall",
					id: "tool-call-1",
					name: "queue_command_test",
					arguments: {},
				},
			],
			extensionsResult,
		);
		session = result.session;

		await session.prompt("start");

		expect(queuedCommandRan).toBe(true);
		expect(queuedCommandArgs).toBe("from-tool");
		expect(commandSawIdle).toBe(true);
		expect(session.pendingMessageCount).toBe(0);

		const userMessages = result.sessionManager
			.getEntries()
			.filter(isUserMessageEntry)
			.map((entry) =>
				typeof entry.message.content === "string"
					? entry.message.content
					: entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			);
		expect(userMessages).toEqual(["start"]);
	});

	it("keeps the session globally busy while queued commands run", async () => {
		let commandSawIdle: boolean | undefined;
		const commandStarted = createDeferred();
		const releaseCommand = createDeferred();

		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "queue_slow_command_test",
					label: "Queue Slow Command Test",
					description: "Queue a slow extension command after the turn.",
					parameters: Type.Object({}),
					execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
						ctx.queueCommand("slow-queued-command");
						return {
							content: [{ type: "text", text: "queued slow command" }],
							details: {},
						};
					},
				});
				pi.registerCommand("slow-queued-command", {
					description: "Wait until released.",
					handler: async (_args, ctx) => {
						commandSawIdle = ctx.isIdle();
						commandStarted.resolve();
						await releaseCommand.promise;
					},
				});
			},
		]);

		const result = await createSession(
			makeTempDir(),
			[
				{
					type: "toolCall",
					id: "tool-call-1",
					name: "queue_slow_command_test",
					arguments: {},
				},
			],
			extensionsResult,
		);
		session = result.session;

		const promptPromise = session.prompt("start");
		await commandStarted.promise;

		expect(commandSawIdle).toBe(true);
		expect(session.isStreaming).toBe(true);
		expect(session.isIdle).toBe(false);
		await expect(session.prompt("racy external prompt")).rejects.toThrow("Agent is already processing");

		releaseCommand.resolve();
		await promptPromise;
		expect(session.isIdle).toBe(true);
	});

	it("runs multiple non-terminal queued extension commands in FIFO order", async () => {
		const commandsRun: string[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "queue_two_commands_test",
					label: "Queue Two Commands Test",
					description: "Queue two non-terminal extension commands after the turn.",
					parameters: Type.Object({}),
					execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
						ctx.queueCommand("record-command-one", "first");
						ctx.queueCommand("record-command-two", "second");
						return {
							content: [{ type: "text", text: "queued two commands" }],
							details: {},
						};
					},
				});
				pi.registerCommand("record-command-one", {
					description: "Record first queued command.",
					handler: async (args) => {
						commandsRun.push(`one:${args}`);
					},
				});
				pi.registerCommand("record-command-two", {
					description: "Record second queued command.",
					handler: async (args) => {
						commandsRun.push(`two:${args}`);
					},
				});
			},
		]);

		const result = await createSession(
			makeTempDir(),
			[
				{
					type: "toolCall",
					id: "tool-call-1",
					name: "queue_two_commands_test",
					arguments: {},
				},
			],
			extensionsResult,
		);
		session = result.session;

		await session.prompt("start");

		expect(commandsRun).toEqual(["one:first", "two:second"]);
		expect(session.pendingMessageCount).toBe(0);
	});

	it("rejects queue attempts after a terminal queued extension command", async () => {
		let terminalRan = false;
		let laterRan = false;
		let rejectionMessage: string | undefined;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "queue_terminal_command_test",
					label: "Queue Terminal Command Test",
					description: "Queue a terminal command and then try to queue another command.",
					parameters: Type.Object({}),
					execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
						ctx.queueCommand("terminal-command", "nav", { terminal: true });
						try {
							ctx.queueCommand("later-command", "stale");
						} catch (error) {
							rejectionMessage = error instanceof Error ? error.message : String(error);
						}
						return {
							content: [{ type: "text", text: "queued terminal command" }],
							details: {},
						};
					},
				});
				pi.registerCommand("terminal-command", {
					description: "Mark that a terminal queued command ran.",
					handler: async () => {
						terminalRan = true;
					},
				});
				pi.registerCommand("later-command", {
					description: "Mark that a later queued command ran.",
					handler: async () => {
						laterRan = true;
					},
				});
			},
		]);

		const result = await createSession(
			makeTempDir(),
			[
				{
					type: "toolCall",
					id: "tool-call-1",
					name: "queue_terminal_command_test",
					arguments: {},
				},
			],
			extensionsResult,
		);
		session = result.session;

		await session.prompt("start");

		expect(terminalRan).toBe(true);
		expect(laterRan).toBe(false);
		expect(rejectionMessage).toContain(
			'Cannot queue extension command "later-command" after terminal queued command "terminal-command"',
		);
		expect(session.pendingMessageCount).toBe(0);
	});

	it("rejects commands queued while a terminal queued extension command is running", async () => {
		let rejectionMessage: string | undefined;
		let laterRan = false;
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.registerTool({
					name: "queue_terminal_handler_test",
					label: "Queue Terminal Handler Test",
					description: "Queue a terminal command whose handler tries to queue another command.",
					parameters: Type.Object({}),
					execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
						ctx.queueCommand("terminal-queues-again", "nav", { terminal: true });
						return {
							content: [{ type: "text", text: "queued terminal handler" }],
							details: {},
						};
					},
				});
				pi.registerCommand("terminal-queues-again", {
					description: "Try to queue another command while terminal command is running.",
					handler: async (_args, ctx) => {
						try {
							ctx.queueCommand("later-command", "stale");
						} catch (error) {
							rejectionMessage = error instanceof Error ? error.message : String(error);
						}
					},
				});
				pi.registerCommand("later-command", {
					description: "Mark that a later queued command ran.",
					handler: async () => {
						laterRan = true;
					},
				});
			},
		]);

		const result = await createSession(
			makeTempDir(),
			[
				{
					type: "toolCall",
					id: "tool-call-1",
					name: "queue_terminal_handler_test",
					arguments: {},
				},
			],
			extensionsResult,
		);
		session = result.session;

		await session.prompt("start");

		expect(laterRan).toBe(false);
		expect(rejectionMessage).toContain(
			'Cannot queue extension command "later-command" while terminal queued command "terminal-queues-again" is running',
		);
		expect(session.pendingMessageCount).toBe(0);
	});
});
