import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	BuiltInMessageRenderer,
	BuiltInMessageRendererTransform,
	MarkdownTransformer,
} from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { composeBuiltInMessageRenderer } from "./built-in-message-renderer.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private renderer: BuiltInMessageRenderer<"assistant">;
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private expanded = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		rendererTransforms: readonly BuiltInMessageRendererTransform<"assistant">[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.renderer = composeBuiltInMessageRenderer(
			(currentMessage, currentOptions) => ({
				component: this.buildFallbackContent(currentMessage, currentOptions.outputPad),
				renderShell: "default",
			}),
			rendererTransforms,
		);

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.hasToolCalls = message.content.some((content) => content.type === "toolCall");

		const rendered = this.renderer(
			message,
			{ expanded: this.expanded, outputPad: this.outputPad, isStreaming: this.isStreaming },
			theme,
		);

		this.contentContainer.clear();
		this.contentContainer.addChild(rendered.component);
	}

	private buildFallbackContent(message: AssistantMessage, outputPad: number): Container {
		const contentContainer = new Container();
		const hasVisibleContent = message.content.some(
			(content) =>
				(content.type === "text" && content.text.trim()) ||
				(content.type === "thinking" && content.thinking.trim()),
		);

		if (hasVisibleContent) {
			contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				contentContainer.addChild(
					new Markdown(content.text.trim(), outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some(
						(nextContent) =>
							(nextContent.type === "text" && nextContent.text.trim()) ||
							(nextContent.type === "thinking" && nextContent.thinking.trim()),
					);

				if (this.hideThinkingBlock) {
					// Show one static label for each run of thinking blocks when hidden.
					contentContainer.addChild(
						new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), outputPad, 0),
					);
				} else {
					// Render each run of thinking blocks as one Markdown section.
					contentContainer.addChild(
						new Markdown(
							thinkingBlocks.join("\n\n"),
							outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						),
					);
				}
				if (hasVisibleContentAfter) {
					contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		if (message.stopReason === "length") {
			contentContainer.addChild(new Spacer(1));
			contentContainer.addChild(
				new Text(
					theme.fg(
						"error",
						"Error: Model stopped because it reached the maximum output token limit. The response may be incomplete.",
					),
					outputPad,
					0,
				),
			);
		} else if (!this.hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				contentContainer.addChild(new Spacer(1));
				contentContainer.addChild(new Text(theme.fg("error", abortMessage), outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				contentContainer.addChild(new Spacer(1));
				contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), outputPad, 0));
			}
		}

		return contentContainer;
	}
}
