import type { UserMessage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import type { TurnBoundaryRenderer, TurnBoundaryRendererTransform } from "../src/core/extensions/types.ts";
import { composeTurnBoundaryRenderer } from "../src/modes/interactive/components/turn-boundary-renderer.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const message: UserMessage = {
	role: "user",
	content: "hello",
	timestamp: 1,
};

const context = { message, source: "interactive" as const, isReplay: false };

function wrappingTransform(label: string, trace: string[]): TurnBoundaryRendererTransform {
	return (current) => (currentContext, currentTheme) => {
		trace.push(`${label}:before`);
		const rendered = current(currentContext, currentTheme);
		trace.push(`${label}:after`);
		const component = new Container();
		component.addChild(new Text(label, 0, 0));
		component.addChild(rendered);
		return component;
	};
}

describe("composeTurnBoundaryRenderer", () => {
	test("composes later transforms outside earlier transforms", () => {
		initTheme("dark");
		const trace: string[] = [];
		const fallback: TurnBoundaryRenderer = () => {
			trace.push("fallback");
			return new Text("content", 0, 0);
		};
		const renderer = composeTurnBoundaryRenderer(fallback, [
			wrappingTransform("inner", trace),
			wrappingTransform("outer", trace),
		]);

		const result = renderer(context, theme);

		expect(trace).toEqual(["outer:before", "inner:before", "fallback", "inner:after", "outer:after"]);
		expect(result.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["outer", "inner", "content"]);
	});

	test("isolates the source context from transform mutations", () => {
		initTheme("dark");
		const source = {
			message: { ...message, content: [{ type: "text" as const, text: "original" }] },
			source: "rpc" as const,
			isReplay: false,
		};
		const mutate: TurnBoundaryRendererTransform = (current) => (currentContext, currentTheme) => {
			if (typeof currentContext.message.content !== "string") {
				const text = currentContext.message.content.find((part) => part.type === "text");
				if (text) text.text = "mutated";
			}
			return current(currentContext, currentTheme);
		};
		const fallback: TurnBoundaryRenderer = (currentContext) => {
			const content = currentContext.message.content;
			const text =
				typeof content === "string" ? content : (content.find((part) => part.type === "text")?.text ?? "");
			return new Text(text, 0, 0);
		};

		const result = composeTurnBoundaryRenderer(fallback, [mutate])(source, theme);

		expect(result.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["mutated"]);
		expect(source.message.content).toEqual([{ type: "text", text: "original" }]);
	});

	test("keeps healthy transforms when registration or rendering fails", () => {
		initTheme("dark");
		const trace: string[] = [];
		const brokenRegistration: TurnBoundaryRendererTransform = () => {
			throw new Error("registration failed");
		};
		const brokenRender = (() => () => {
			throw new Error("render failed");
		}) as TurnBoundaryRendererTransform;
		const fallback: TurnBoundaryRenderer = () => new Text("fallback", 0, 0);
		const renderer = composeTurnBoundaryRenderer(fallback, [
			brokenRegistration,
			brokenRender,
			wrappingTransform("healthy", trace),
		]);

		const result = renderer(context, theme);

		expect(trace).toEqual(["healthy:before", "healthy:after"]);
		expect(result.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["healthy", "fallback"]);
	});

	test("isolates a fallback layer from mutations made by a failed transform", () => {
		initTheme("dark");
		const mutateThenThrow: TurnBoundaryRendererTransform = () => (currentContext) => {
			currentContext.source = "rpc";
			throw new Error("render failed");
		};
		const fallback: TurnBoundaryRenderer = (currentContext) => new Text(currentContext.source ?? "unknown", 0, 0);

		const result = composeTurnBoundaryRenderer(fallback, [mutateThenThrow])(context, theme);

		expect(result.render(40).map((line) => stripAnsi(line).trimEnd())).toEqual(["interactive"]);
	});
});
