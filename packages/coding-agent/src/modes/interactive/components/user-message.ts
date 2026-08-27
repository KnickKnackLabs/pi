import { Box, type Component, Container, Markdown, type MarkdownTheme, Spacer } from "@earendil-works/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import type {
	BuiltInMessageByRole,
	BuiltInMessageRenderer,
	BuiltInMessageRendererTransform,
	MarkdownTransformer,
	SessionMessageRenderContext,
} from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { composeBuiltInMessageRenderer } from "./built-in-message-renderer.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { SkillInvocationMessageComponent } from "./skill-invocation-message.ts";

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
	private renderContext: SessionMessageRenderContext;
	private skillBlock?: ParsedSkillBlock;
	private expanded = false;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		rendererTransforms: readonly BuiltInMessageRendererTransform<"user">[] = [],
		message?: BuiltInMessageByRole["user"],
		renderContext: SessionMessageRenderContext = {},
		skillBlock?: ParsedSkillBlock,
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.skillBlock = skillBlock;
		this.renderer = composeBuiltInMessageRenderer(
			() =>
				this.skillBlock
					? { component: this.createSkillSurface(), renderShell: "self" }
					: { component: this.createMessageBody(), renderShell: "default" },
			rendererTransforms,
		);
		this.message = message;
		this.renderContext = renderContext;
		this.rebuild();
	}

	setRenderContext(renderContext: SessionMessageRenderContext): void {
		this.renderContext = renderContext;
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

	private createMessageBody(): Markdown {
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

	private createSkillSurface(): Component {
		const surface = new Container();
		const skill = new SkillInvocationMessageComponent(this.skillBlock!, this.markdownTheme);
		skill.setExpanded(this.expanded);
		surface.addChild(skill);
		if (this.text) {
			surface.addChild(new Spacer(1));
			const contentBox = new Box(this.outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
			contentBox.addChild(this.createMessageBody());
			surface.addChild(contentBox);
		}
		return surface;
	}

	private rebuild(): void {
		this.clear();
		const rendered = this.message
			? this.renderer(
					this.message,
					{
						...this.renderContext,
						expanded: this.expanded,
						outputPad: this.outputPad,
						isStreaming: false,
					},
					theme,
				)
			: { component: this.createMessageBody(), renderShell: "default" as const };

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
