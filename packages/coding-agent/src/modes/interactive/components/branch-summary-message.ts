import { Box, type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type {
	BuiltInMessageRenderer,
	BuiltInMessageRendererTransform,
	SessionMessageRenderContext,
} from "../../../core/extensions/types.ts";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { composeBuiltInMessageRenderer } from "./built-in-message-renderer.ts";
import { keyText } from "./keybinding-hints.ts";

/** A complete branch-summary row, including spacing and native disclosure. */
export class BranchSummaryMessageComponent extends Container {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private renderer: BuiltInMessageRenderer<"branchSummary">;
	private renderContext: SessionMessageRenderContext;
	private outputPad: number;

	constructor(
		message: BranchSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		transforms: readonly BuiltInMessageRendererTransform<"branchSummary">[] = [],
		renderContext: SessionMessageRenderContext = {},
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.renderContext = renderContext;
		this.outputPad = outputPad;
		this.renderer = composeBuiltInMessageRenderer((snapshot, options) => {
			const body = new Container();
			body.addChild(new Text(theme.fg("customMessageLabel", `\x1b[1m[branch]\x1b[22m`), 0, 0));
			body.addChild(new Spacer(1));
			if (options.expanded) {
				body.addChild(
					new Markdown(`**Branch Summary**\n\n${snapshot.summary}`, 0, 0, this.markdownTheme, {
						color: (text: string) => theme.fg("customMessageText", text),
					}),
				);
			} else {
				body.addChild(
					new Text(
						theme.fg("customMessageText", "Branch summary (") +
							theme.fg("dim", keyText("app.tools.expand")) +
							theme.fg("customMessageText", " to expand)"),
						0,
						0,
					),
				);
			}
			return { component: this.nativeRow(body), renderShell: "self" };
		}, transforms);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private nativeRow(body: Component): Container {
		const row = new Container();
		row.addChild(new Spacer(1));
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(body);
		row.addChild(box);
		return row;
	}

	private updateDisplay(): void {
		this.clear();
		const result = this.renderer(
			this.message,
			{
				...this.renderContext,
				expanded: this.expanded,
				outputPad: this.outputPad,
				isStreaming: false,
			},
			theme,
		);
		if (result.renderShell === "self") {
			this.addChild(result.component);
		} else {
			this.addChild(this.nativeRow(result.component));
		}
	}
}
