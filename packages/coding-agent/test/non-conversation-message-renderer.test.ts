import { Container, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, test } from "vitest";
import type { BuiltInMessageRendererTransform, BuiltInMessageRenderOptions } from "../src/core/extensions/types.ts";
import type { BranchSummaryMessage, CustomMessage } from "../src/core/messages.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const summary: BranchSummaryMessage = {
	role: "branchSummary",
	summary: "carried **body**",
	fromId: "source",
	timestamp: 1,
};
const custom: CustomMessage = {
	role: "custom",
	customType: "receipt",
	content: "receipt body",
	details: { source: "source" },
	display: true,
	timestamp: 2,
};
const lines = (component: Container) => component.render(60).map((line) => stripAnsi(line).trimEnd());

beforeEach(() => initTheme("dark"));

describe("non-conversation message transforms", () => {
	test("branch summary delegates the entire native row and stable entry provenance", () => {
		const seen: BuiltInMessageRenderOptions[] = [];
		let factories = 0;
		const transform: BuiltInMessageRendererTransform<"branchSummary"> = (previous) => {
			factories++;
			return (message, options, theme) => {
				seen.push(options);
				return previous(message, options, theme);
			};
		};
		const component = new BranchSummaryMessageComponent(summary, undefined, [transform], { entryId: "summary-id" });
		expect(lines(component)[0]).toBe("");
		expect(lines(component).join("\n")).toContain("Branch summary (");
		component.setExpanded(true);
		expect(lines(component).join("\n")).toContain("carried body");
		component.invalidate();
		component.setOutputPad(0);
		expect(factories).toBe(1);
		expect(seen.at(-1)).toEqual({ entryId: "summary-id", expanded: true, outputPad: 0, isStreaming: false });
	});

	test("self-rendered hidden summaries leave no spacer or box rows", () => {
		const component = new BranchSummaryMessageComponent(summary, undefined, [
			() => () => ({ component: new Container(), renderShell: "self" }),
		]);
		expect(component.render(60)).toEqual([]);
		component.setExpanded(true);
		component.invalidate();
		expect(component.render(20)).toEqual([]);
	});

	test("custom transform delegates a registered renderer including its leading spacer", () => {
		const component = new CustomMessageComponent(
			custom,
			() => new Text("registered rich content", 0, 0),
			undefined,
			1,
			{ entryId: "receipt-id" },
			[
				(previous) => (message, options, theme) => {
					const native = previous(message, options, theme);
					const wrapper = new Container();
					wrapper.addChild(new Text(`owner ${options.entryId}`, 0, 0));
					wrapper.addChild(native.component);
					return { component: wrapper, renderShell: "self" };
				},
			],
		);
		expect(lines(component)).toEqual(["owner receipt-id", "", "registered rich content"]);
	});

	test("a custom row can dynamically hide all spacing and retain its factory on persistence", () => {
		let hide = false;
		let factories = 0;
		const seen: (string | undefined)[] = [];
		const component = new CustomMessageComponent(custom, () => new Text("native", 0, 0), undefined, 1, {}, [
			(previous) => {
				factories++;
				return (message, options, theme) => {
					seen.push(options.entryId);
					const native = previous(message, options, theme);
					return {
						component: {
							render: (width) => (hide ? [] : native.component.render(width)),
							invalidate: () => native.component.invalidate(),
						},
						renderShell: "self",
					};
				};
			},
		]);
		expect(lines(component)).toEqual(["", "native"]);
		hide = true;
		expect(lines(component)).toEqual([]);
		component.setRenderContext({ entryId: "saved" });
		component.setExpanded(true);
		component.invalidate();
		expect(lines(component)).toEqual([]);
		hide = false;
		expect(lines(component)).toEqual(["", "native"]);
		expect(factories).toBe(1);
		expect(seen[0]).toBeUndefined();
		expect(seen.at(-1)).toBe("saved");
	});

	test("display mutations do not change stored summaries or custom details", () => {
		const component = new BranchSummaryMessageComponent(summary, undefined, [
			(previous) => (message, options, theme) => {
				message.summary = "display only";
				return previous(message, options, theme);
			},
		]);
		component.setExpanded(true);
		expect(lines(component).join("\n")).toContain("display only");
		expect(summary.summary).toBe("carried **body**");
		new CustomMessageComponent(custom, undefined, undefined, 1, {}, [
			(previous) => (message, options, theme) => {
				(message.details as { source: string }).source = "changed";
				return previous(message, options, theme);
			},
		]);
		expect(custom.details).toEqual({ source: "source" });
	});

	test("throwing transforms fall back to complete native rows", () => {
		const branch = new BranchSummaryMessageComponent(summary, undefined, [
			() => () => {
				throw new Error("broken");
			},
		]);
		expect(lines(branch)[0]).toBe("");
		expect(lines(branch).join("\n")).toContain("[branch]");
		const receipt = new CustomMessageComponent(custom, () => new Text("registered", 0, 0), undefined, 1, {}, [
			() => () => {
				throw new Error("broken");
			},
		]);
		expect(lines(receipt)).toEqual(["", "registered"]);
	});
});
