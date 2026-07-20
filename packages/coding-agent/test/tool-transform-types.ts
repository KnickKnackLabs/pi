import { Type } from "typebox";
import type { ExtensionAPI, NamedToolDefinition, ToolDefinition } from "../src/core/extensions/types.ts";

const customParameters = Type.Object({ value: Type.String() });
type CustomTool = NamedToolDefinition<
	"custom_tool",
	ToolDefinition<typeof customParameters, { echoed: string }, { renders: number }>
>;

// This function is compiled by the repository typecheck and never runs.
export function checkToolTransformTypes(pi: ExtensionAPI): void {
	pi.registerTool("read", (current) => ({
		...current,
		async execute(toolCallId, params, signal, onUpdate, context) {
			params.path satisfies string;
			const result = await current.execute(toolCallId, params, signal, onUpdate, context);
			result.details?.truncation?.truncated satisfies boolean | undefined;
			return result;
		},
	}));

	pi.registerTool("bash", (current) => ({
		...current,
		async execute(toolCallId, params, signal, onUpdate, context) {
			params.command satisfies string;
			const result = await current.execute(toolCallId, params, signal, onUpdate, context);
			result.details?.fullOutputPath satisfies string | undefined;
			return result;
		},
	}));

	pi.registerTool<CustomTool>("custom_tool", (current) => ({
		...current,
		async execute(toolCallId, params, signal, onUpdate, context) {
			const result = await current.execute(toolCallId, params, signal, onUpdate, context);
			result.details.echoed satisfies string;
			return result;
		},
	}));

	// @ts-expect-error transforms cannot rename the registered tool
	pi.registerTool("read", (current) => ({ ...current, name: "other" }));

	// @ts-expect-error transforms cannot replace the registered tool's parameter schema
	pi.registerTool("read", (current) => ({ ...current, parameters: customParameters }));

	// @ts-expect-error explicitly typed custom transforms must use their declared name
	pi.registerTool<CustomTool>("other", (current) => current);
}
