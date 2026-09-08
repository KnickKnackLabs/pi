import type { TextContent } from "@earendil-works/pi-ai";
import { Box, type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	BuiltInMessageRenderer,
	BuiltInMessageRendererTransform,
	MessageRenderer,
	MessageRenderOptions,
	SessionMessageRenderContext,
} from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { composeBuiltInMessageRenderer } from "./built-in-message-renderer.ts";

/** Complete custom-message row; whole-row transforms also own the leading spacer. */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private renderContext: SessionMessageRenderContext;
	private renderer: BuiltInMessageRenderer<"custom">;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		renderContext: SessionMessageRenderContext = {},
		transforms: readonly BuiltInMessageRendererTransform<"custom">[] = [],
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.renderContext = renderContext;
		this.renderer = composeBuiltInMessageRenderer((snapshot, options) => {
			const row = new Container();
			row.addChild(new Spacer(1));
			const { isStreaming: _isStreaming, ...customOptions } = options;
			row.addChild(this.nativeContent(snapshot, customOptions));
			return { component: row, renderShell: "self" };
		}, transforms);
		this.rebuild();
	}

	setRenderContext(renderContext: SessionMessageRenderContext): void {
		this.renderContext = renderContext;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private nativeContent(message: CustomMessage<unknown>, options: MessageRenderOptions): Component {
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(message, options, theme);
				if (component) return component;
			} catch {
				// Preserve native fallback if a registered custom renderer fails.
			}
		}
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[${message.customType}]\x1b[22m`), 0, 0));
		box.addChild(new Spacer(1));
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join("\n");
		box.addChild(
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (value: string) => theme.fg("customMessageText", value),
			}),
		);
		return box;
	}

	private rebuild(): void {
		this.clear();
		const result = this.renderer(
			this.message,
			{
				...this.renderContext,
				expanded: this._expanded,
				outputPad: this.outputPad,
				isStreaming: false,
			},
			theme,
		);
		if (result.renderShell === "self") {
			this.addChild(result.component);
		} else {
			this.addChild(new Spacer(1));
			const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(result.component);
			this.addChild(box);
		}
	}
}
