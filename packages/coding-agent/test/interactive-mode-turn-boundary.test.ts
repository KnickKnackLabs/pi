import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { InputSource, TurnBoundaryContext } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const createTurnBoundary = Reflect.get(InteractiveMode.prototype, "createTurnBoundary");
const addMessageToChat = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
	this: ReturnType<typeof createFakeMode>,
	message: AgentMessage,
	options?: { populateHistory?: boolean; source?: InputSource; isReplay?: boolean },
) => void;

function userMessage(content: string, timestamp: number): AgentMessage {
	return { role: "user", content, timestamp };
}

function createFakeMode(contexts: TurnBoundaryContext[] = [], useBoundary = true) {
	const transforms = useBoundary
		? [
				() => (context: TurnBoundaryContext) => {
					contexts.push(context);
					return new Text("boundary", 0, 0);
				},
			]
		: [];
	return {
		chatContainer: new Container(),
		createTurnBoundary,
		getUserMessageText: (message: AgentMessage) =>
			message.role === "user"
				? typeof message.content === "string"
					? message.content
					: (message.content.find((part) => part.type === "text")?.text ?? "")
				: "",
		session: {
			extensionRunner: {
				getTurnBoundaryRendererTransforms: () => transforms,
				getBuiltInMessageRendererTransforms: () => [],
			},
		},
		getMarkdownThemeWithSettings: () => undefined,
		outputPad: 1,
		getMarkdownTransformers: () => [],
		toolOutputExpanded: false,
		editor: { addToHistory: vi.fn() },
	};
}

describe("InteractiveMode turn boundaries", () => {
	test("keeps the first message boundary-free and passes live context to later boundaries", () => {
		initTheme("dark");
		const contexts: TurnBoundaryContext[] = [];
		const fakeMode = createFakeMode(contexts);

		addMessageToChat.call(fakeMode, userMessage("first", 1), { source: "interactive", isReplay: false });
		addMessageToChat.call(fakeMode, userMessage("second", 2), { source: "rpc", isReplay: false });

		expect(contexts).toEqual([
			expect.objectContaining({
				source: "rpc",
				isReplay: false,
				message: expect.objectContaining({ content: "second" }),
			}),
		]);
		expect(fakeMode.chatContainer.children).toHaveLength(3);
		expect(fakeMode.chatContainer.children[1]?.render(40).map((line) => line.trimEnd())).toEqual(["boundary"]);
	});

	test("preserves the default spacer when no extension overrides it", () => {
		initTheme("dark");
		const fakeMode = createFakeMode([], false);

		addMessageToChat.call(fakeMode, userMessage("first", 1));
		addMessageToChat.call(fakeMode, userMessage("second", 2));

		expect(fakeMode.chatContainer.children).toHaveLength(3);
		expect(fakeMode.chatContainer.children[1]).toBeInstanceOf(Spacer);
	});

	test("does not invoke the boundary hook for the first user message after non-user content", () => {
		initTheme("dark");
		const contexts: TurnBoundaryContext[] = [];
		const fakeMode = createFakeMode(contexts);
		fakeMode.chatContainer.addChild(new Text("notice", 0, 0));

		addMessageToChat.call(fakeMode, userMessage("first", 1), { source: "interactive", isReplay: false });

		expect(contexts).toEqual([]);
		expect(fakeMode.chatContainer.children).toHaveLength(3);
		expect(fakeMode.chatContainer.children[1]).toBeInstanceOf(Spacer);
	});

	test("invokes the outer boundary for replayed skill user turns", () => {
		initTheme("dark");
		const contexts: TurnBoundaryContext[] = [];
		const fakeMode = createFakeMode(contexts);
		const skill = '<skill name="demo" location="/tmp/demo.md">\nSkill body\n</skill>\n\nDo this';

		addMessageToChat.call(fakeMode, userMessage("first", 1));
		addMessageToChat.call(fakeMode, userMessage(skill, 2), { isReplay: true });

		expect(contexts).toEqual([
			expect.objectContaining({
				source: undefined,
				isReplay: true,
				message: expect.objectContaining({ content: skill }),
			}),
		]);
		expect(fakeMode.chatContainer.children[1]?.render(40).map((line) => line.trimEnd())).toEqual(["boundary"]);
		expect(fakeMode.chatContainer.children.filter((child) => child instanceof Spacer)).toHaveLength(1);
	});
});
