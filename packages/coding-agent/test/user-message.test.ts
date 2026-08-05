import type { UserMessage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("passes the complete message and current render options to renderer transforms", () => {
		initTheme("dark");
		const message: UserMessage = {
			role: "user",
			content: "hello",
			timestamp: 123,
		};
		const calls: Array<{ message: UserMessage; expanded: boolean; outputPad: number; isStreaming: boolean }> = [];
		let compositions = 0;
		const component = new UserMessageComponent(
			"hello",
			undefined,
			2,
			[],
			[
				(current) => {
					compositions++;
					return (currentMessage, options, theme) => {
						calls.push({ message: currentMessage, ...options });
						const fallback = current(currentMessage, { ...options, outputPad: 0 }, theme);
						const content = new Container();
						content.addChild(new Text("metadata", 0, 0));
						content.addChild(fallback.component);
						return { component: content, renderShell: "self" };
					};
				},
			],
			message,
		);

		component.setExpanded(true);
		const rendered = stripAnsi(component.render(80).join("\n"));

		expect(rendered).toContain("metadata");
		expect(rendered).toContain("hello");
		expect(compositions).toBe(1);
		expect(calls).toEqual([
			{ message, expanded: false, outputPad: 2, isStreaming: false },
			{ message, expanded: true, outputPad: 2, isStreaming: false },
		]);
	});
});
