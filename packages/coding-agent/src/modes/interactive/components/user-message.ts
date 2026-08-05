import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import type {
	BuiltInMessageByRole,
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
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private renderer: BuiltInMessageRenderer<"user">;
	private message?: BuiltInMessageByRole["user"];
	private expanded = false;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		rendererTransforms: readonly BuiltInMessageRendererTransform<"user">[] = [],
		message?: BuiltInMessageByRole["user"],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.renderer = composeBuiltInMessageRenderer(
			() => ({ component: this.createFallback(), renderShell: "default" }),
			rendererTransforms,
		);
		this.message = message;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private createFallback(): Markdown {
		return new Markdown(
			this.text,
			0,
			0,
			this.markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
			},
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				transform: createMarkdownTransform("user", false, this.markdownTransformers),
			},
		);
	}

	private rebuild(): void {
		this.clear();
		const rendered = this.message
			? this.renderer(
					this.message,
					{ expanded: this.expanded, outputPad: this.outputPad, isStreaming: false },
					theme,
				)
			: { component: this.createFallback(), renderShell: "default" as const };

		if (rendered.renderShell === "self") {
			this.addChild(rendered.component);
			return;
		}

		const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
		contentBox.addChild(rendered.component);
		this.addChild(contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
