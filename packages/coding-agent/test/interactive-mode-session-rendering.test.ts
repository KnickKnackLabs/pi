import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionMessageRenderContext } from "../src/core/extensions/types.ts";
import type { CustomMessageEntry, SessionEntry } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
	this: ReturnType<typeof createMessageMode>,
	message: AgentMessage,
	options?: { populateHistory?: boolean; isReplay?: boolean; renderContext?: SessionMessageRenderContext },
) => void;

const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
	this: { renderSessionItems: ReturnType<typeof vi.fn> },
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as (
	this: ReturnType<typeof createFakeMode>,
	items: Array<{ type: string; message?: AgentMessage; renderContext?: SessionMessageRenderContext }>,
	options?: { updateFooter?: boolean; populateHistory?: boolean; isReplay?: boolean },
) => void;

const applyPersistedMessageRenderContext = Reflect.get(
	InteractiveMode.prototype,
	"applyPersistedMessageRenderContext",
) as (this: Record<string, unknown>, message: AgentMessage) => void;

function createMessageMode() {
	return {
		chatContainer: new Container(),
		getUserMessageText: (message: AgentMessage) =>
			message.role === "user"
				? typeof message.content === "string"
					? message.content
					: (message.content.find((part) => part.type === "text")?.text ?? "")
				: "",
		session: {
			extensionRunner: {
				getMessageRenderer: () => undefined,
				getBuiltInMessageRendererTransforms: () => [],
				getTurnBoundaryRendererTransforms: () => [],
			},
		},
		getMarkdownThemeWithSettings: () => undefined,
		outputPad: 1,
		getMarkdownTransformers: () => [],
		toolOutputExpanded: false,
		editor: { addToHistory: vi.fn() },
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		createTurnBoundary: Reflect.get(InteractiveMode.prototype, "createTurnBoundary"),
	};
}

function createFakeMode() {
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		toolCallMessageRenderContexts: new Map<string, SessionMessageRenderContext>(),
		liveMessageComponents: new WeakMap<AgentMessage, UserMessageComponent | CustomMessageComponent>(),
		settingsManager: {
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: {
			getEntries: () => [],
			getCwd: () => process.cwd(),
		},
		session: { modelRuntime: {}, retryAttempt: 0 },
		chatContainer: new Container(),
		toolOutputExpanded: false,
		getRegisteredToolDefinition: () => undefined,
		ui: { requestRender: vi.fn() } as unknown as TUI,
		addMessageToChat: vi.fn(),
		addCustomEntryToChat: vi.fn(),
		addCompactionCostNotice: vi.fn(),
		addCacheMissNotice: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
	};
}

describe("InteractiveMode persisted session rendering", () => {
	test("carries canonical entry metadata into replay items", () => {
		const message: AgentMessage = { role: "user", content: "hello", timestamp: 1 };
		const entry: SessionEntry = {
			type: "message",
			id: "user-entry",
			parentId: null,
			timestamp: "2026-08-25T00:00:00.000Z",
			message,
			segmentNumber: 3,
			segmentKind: "user",
			inputKind: "follow-up",
		};
		const fake = { renderSessionItems: vi.fn() };

		renderSessionEntries.call(fake, [entry], { populateHistory: true });

		expect(fake.renderSessionItems).toHaveBeenCalledWith(
			[
				{
					type: "session_message",
					message,
					renderContext: {
						entryId: "user-entry",
						segmentNumber: 3,
						segmentKind: "user",
						inputKind: "follow-up",
					},
				},
			],
			{ populateHistory: true, isReplay: true },
		);
	});

	test("projects a persisted custom message entry into its replay renderer", () => {
		initTheme("dark");
		const renderer = vi.fn(() => new Container());
		const entry: CustomMessageEntry = {
			type: "custom_message",
			id: "custom-entry",
			parentId: null,
			timestamp: "2026-08-25T00:00:00.000Z",
			customType: "notice",
			content: "custom",
			display: true,
		};
		const fake = Object.assign(createFakeMode(), createMessageMode(), {
			session: {
				modelRuntime: {},
				retryAttempt: 0,
				extensionRunner: {
					getMessageRenderer: () => renderer,
					getBuiltInMessageRendererTransforms: () => [],
					getTurnBoundaryRendererTransforms: () => [],
				},
			},
			renderSessionItems: vi.fn(),
		});
		fake.addMessageToChat.mockImplementation((message, options) => {
			addMessageToChat.call(fake, message, options);
		});
		fake.renderSessionItems.mockImplementation((items, options) => {
			renderSessionItems.call(fake, items, options);
		});

		renderSessionEntries.call(fake, [entry]);

		expect(renderer).toHaveBeenCalledWith(
			expect.objectContaining({ role: "custom", customType: "notice", content: "custom" }),
			expect.objectContaining({ entryId: "custom-entry" }),
			expect.anything(),
		);
	});

	test("forwards replay context into user, assistant, and custom message components", () => {
		initTheme("dark");
		const context = { entryId: "message-entry", segmentNumber: 4, segmentKind: "agent" as const };
		const fake = createMessageMode();
		const userMessage: AgentMessage = { role: "user", content: "hello", timestamp: 1 };
		const assistantMessage = fauxAssistantMessage("hello back", { timestamp: 2 });
		const customMessage: AgentMessage = {
			role: "custom",
			customType: "notice",
			content: "custom",
			display: true,
			timestamp: 3,
		};

		addMessageToChat.call(fake, userMessage, { isReplay: true, renderContext: context });
		addMessageToChat.call(fake, assistantMessage, { isReplay: true, renderContext: context });
		addMessageToChat.call(fake, customMessage, { isReplay: true, renderContext: context });

		const user = fake.chatContainer.children.find(
			(component): component is UserMessageComponent => component instanceof UserMessageComponent,
		);
		const assistant = fake.chatContainer.children.find(
			(component): component is AssistantMessageComponent => component instanceof AssistantMessageComponent,
		);
		const custom = fake.chatContainer.children.find(
			(component): component is CustomMessageComponent => component instanceof CustomMessageComponent,
		);
		expect(Reflect.get(user!, "renderContext")).toEqual(context);
		expect(Reflect.get(assistant!, "renderContext")).toEqual(context);
		expect(Reflect.get(custom!, "renderContext")).toEqual(context);
	});

	test("tracks live user and custom components until their entries are persisted", () => {
		initTheme("dark");
		const fake = Object.assign(createMessageMode(), {
			liveMessageComponents: new WeakMap<AgentMessage, UserMessageComponent | CustomMessageComponent>(),
		});
		const userMessage: AgentMessage = { role: "user", content: "live", timestamp: 1 };
		const customMessage: AgentMessage = {
			role: "custom",
			customType: "notice",
			content: "live custom",
			display: true,
			timestamp: 2,
		};

		addMessageToChat.call(fake, userMessage, { isReplay: false });
		addMessageToChat.call(fake, customMessage, { isReplay: false });

		expect(fake.liveMessageComponents.get(userMessage)).toBeInstanceOf(UserMessageComponent);
		expect(fake.liveMessageComponents.get(customMessage)).toBeInstanceOf(CustomMessageComponent);
	});

	test("applies persisted context to live messages and separate tool call/result slots", () => {
		const userMessage: AgentMessage = { role: "user", content: "live", timestamp: 1 };
		const customMessage: AgentMessage = {
			role: "custom",
			customType: "notice",
			content: "custom",
			display: true,
			timestamp: 2,
		};
		const assistantMessage = fauxAssistantMessage(fauxToolCall("live_tool", {}, { id: "tool-live" }), {
			stopReason: "toolUse",
			timestamp: 3,
		});
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "tool-live",
			toolName: "live_tool",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 4,
		};
		const contexts = new WeakMap<AgentMessage, SessionMessageRenderContext>([
			[userMessage, { entryId: "user-live", segmentNumber: 1, segmentKind: "user" }],
			[customMessage, { entryId: "custom-live" }],
			[assistantMessage, { entryId: "assistant-live", segmentNumber: 2, segmentKind: "agent" }],
			[toolResult, { entryId: "result-live", segmentNumber: 2, segmentKind: "agent" }],
		]);
		const userComponent = { setRenderContext: vi.fn() };
		const customComponent = { setRenderContext: vi.fn() };
		const assistantComponent = { setRenderContext: vi.fn() };
		const toolComponent = {
			setCallMessageRenderContext: vi.fn(),
			setResultMessageRenderContext: vi.fn(),
		};
		const fake = {
			session: { getMessageRenderContext: (message: AgentMessage) => contexts.get(message) },
			liveMessageComponents: new WeakMap<AgentMessage, typeof userComponent | typeof customComponent>([
				[userMessage, userComponent],
				[customMessage, customComponent],
			]),
			streamingComponent: assistantComponent,
			pendingTools: new Map([["tool-live", toolComponent]]),
			toolCallMessageRenderContexts: new Map<string, SessionMessageRenderContext>(),
		};

		applyPersistedMessageRenderContext.call(fake, userMessage);
		applyPersistedMessageRenderContext.call(fake, customMessage);
		applyPersistedMessageRenderContext.call(fake, assistantMessage);
		applyPersistedMessageRenderContext.call(fake, toolResult);

		expect(userComponent.setRenderContext).toHaveBeenCalledWith(contexts.get(userMessage));
		expect(customComponent.setRenderContext).toHaveBeenCalledWith(contexts.get(customMessage));
		expect(assistantComponent.setRenderContext).toHaveBeenCalledWith(contexts.get(assistantMessage));
		expect(toolComponent.setCallMessageRenderContext).toHaveBeenCalledWith(contexts.get(assistantMessage));
		expect(toolComponent.setResultMessageRenderContext).toHaveBeenCalledWith(contexts.get(toolResult));
		expect(fake.pendingTools).toEqual(new Map());
		expect(fake.toolCallMessageRenderContexts).toEqual(new Map());
	});

	test("keeps assistant call and tool-result entry contexts separate during replay", () => {
		initTheme("dark");
		const userMessage: AgentMessage = { role: "user", content: "run it", timestamp: 1 };
		const assistantMessage = fauxAssistantMessage(fauxToolCall("replay_tool", {}, { id: "tool-1" }), {
			stopReason: "toolUse",
			timestamp: 2,
		});
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "replay_tool",
			content: [{ type: "text", text: "done" }],
			isError: false,
			timestamp: 3,
		};
		const userContext = { entryId: "user-entry", segmentNumber: 1, segmentKind: "user" as const };
		const callContext = { entryId: "assistant-entry", segmentNumber: 2, segmentKind: "agent" as const };
		const resultContext = { entryId: "result-entry", segmentNumber: 2, segmentKind: "agent" as const };
		const fake = createFakeMode();

		renderSessionItems.call(
			fake,
			[
				{ type: "session_message", message: userMessage, renderContext: userContext },
				{ type: "session_message", message: assistantMessage, renderContext: callContext },
				{ type: "session_message", message: toolResult, renderContext: resultContext },
			],
			{ populateHistory: true, isReplay: true },
		);

		expect(fake.addMessageToChat).toHaveBeenNthCalledWith(1, userMessage, {
			populateHistory: true,
			isReplay: true,
			renderContext: userContext,
		});
		expect(fake.addMessageToChat).toHaveBeenNthCalledWith(2, assistantMessage, {
			isReplay: true,
			renderContext: callContext,
		});
		expect(fake.maybeShowAssistantDiagnostics).toHaveBeenCalledExactlyOnceWith(assistantMessage);
		const tool = fake.chatContainer.children.find(
			(component): component is ToolExecutionComponent => component instanceof ToolExecutionComponent,
		);
		expect(tool).toBeDefined();
		expect(Reflect.get(tool!, "callMessage")).toEqual(callContext);
		expect(Reflect.get(tool!, "resultMessage")).toEqual(resultContext);
		expect(fake.pendingTools).toEqual(new Map());
	});
});
