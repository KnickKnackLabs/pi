import type { UserMessage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { BuiltInMessageRenderer, BuiltInMessageRendererTransform } from "../src/core/extensions/types.ts";
import { composeBuiltInMessageRenderer } from "../src/modes/interactive/components/built-in-message-renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: UserMessage = {
	role: "user",
	content: "hello",
	timestamp: 1,
};

const options = {
	expanded: false,
	outputPad: 1,
	isStreaming: false,
};

function wrappingTransform(label: string, trace: string[]): BuiltInMessageRendererTransform<"user"> {
	return (current) => (currentMessage, currentOptions, currentTheme) => {
		trace.push(`${label}:before`);
		const rendered = current(currentMessage, currentOptions, currentTheme);
		trace.push(`${label}:after`);
		const component = new Container();
		component.addChild(new Text(label, 0, 0));
		component.addChild(rendered.component);
		return { component, renderShell: rendered.renderShell };
	};
}

describe("composeBuiltInMessageRenderer", () => {
	test("composes later transforms outside earlier transforms", () => {
		initTheme("dark");
		const trace: string[] = [];
		const fallback: BuiltInMessageRenderer<"user"> = () => {
			trace.push("fallback");
			return { component: new Text("content", 0, 0), renderShell: "default" };
		};

		const renderer = composeBuiltInMessageRenderer(fallback, [
			wrappingTransform("inner", trace),
			wrappingTransform("outer", trace),
		]);
		const result = renderer(message, options, theme);

		expect(trace).toEqual(["outer:before", "inner:before", "fallback", "inner:after", "outer:after"]);
		expect(result.component.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual([
			"outer",
			"inner",
			"content",
		]);
		expect(result.renderShell).toBe("default");
	});

	test("keeps later transforms when an earlier transform throws during registration", () => {
		initTheme("dark");
		const trace: string[] = [];
		const fallback: BuiltInMessageRenderer<"user"> = () => ({
			component: new Text("fallback", 0, 0),
			renderShell: "default",
		});
		const broken: BuiltInMessageRendererTransform<"user"> = () => {
			throw new Error("registration failed");
		};

		const renderer = composeBuiltInMessageRenderer(fallback, [broken, wrappingTransform("healthy", trace)]);
		const result = renderer(message, options, theme);

		expect(trace).toEqual(["healthy:before", "healthy:after"]);
		expect(result.component.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["healthy", "fallback"]);
	});

	test.each([
		[
			"throws",
			() => {
				throw new Error("render failed");
			},
		],
		["returns no result", () => undefined],
		["returns an invalid shell", () => ({ component: new Text("bad", 0, 0), renderShell: "invalid" })],
	])("falls back when a transform %s", (_label, render) => {
		initTheme("dark");
		const fallback: BuiltInMessageRenderer<"user"> = () => ({
			component: new Text("fallback", 0, 0),
			renderShell: "default",
		});
		const transform = (() => render) as unknown as BuiltInMessageRendererTransform<"user">;

		const renderer = composeBuiltInMessageRenderer(fallback, [transform]);
		const result = renderer(message, options, theme);

		expect(result.component.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["fallback"]);
		expect(result.renderShell).toBe("default");
	});
});
