import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type {
	AnyToolDefinition,
	RegisteredTool,
	RegisteredToolTransform,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { resolveToolDefinitions } from "../src/core/tools/tool-resolution.ts";

const parameters = Type.Object({ value: Type.String() });

type TestTool = ToolDefinition<typeof parameters, { trace: string[] }>;

function source(path: string) {
	return createSyntheticSourceInfo(path, { source: "test" });
}

function createTool(name: string, trace: string[], sourcePath = `<base:${name}>`): RegisteredTool {
	const definition: TestTool = {
		name,
		label: name,
		description: `${name} base`,
		parameters,
		async execute(): Promise<AgentToolResult<{ trace: string[] }>> {
			trace.push(`${name}:base`);
			return {
				content: [{ type: "text", text: name }],
				details: { trace },
			};
		},
	};
	return { definition, sourceInfo: source(sourcePath) };
}

function createTransform(
	name: string,
	registrationOrder: number,
	label: string,
	trace: string[],
): RegisteredToolTransform {
	return {
		name,
		registrationOrder,
		sourceInfo: source(`<transform:${label}>`),
		transform(current) {
			return {
				...current,
				async execute(toolCallId, args, signal, onUpdate, context) {
					trace.push(`${label}:before`);
					const result = await current.execute(toolCallId, args, signal, onUpdate, context);
					trace.push(`${label}:after`);
					return result;
				},
			};
		},
	};
}

describe("resolveToolDefinitions", () => {
	it("applies transforms in registration order with later transforms outside earlier ones", async () => {
		const trace: string[] = [];
		const base = createTool("read", trace);
		const inner = createTransform("read", 1, "inner", trace);
		const outer = createTransform("read", 2, "outer", trace);

		const resolved = resolveToolDefinitions([base], [outer, inner]);
		const read = resolved.definitions.get("read");

		expect(resolved.failures).toEqual([]);
		expect(read?.sourceInfo.path).toBe("<base:read>");
		expect(read?.transformedBy.map((item) => item.path)).toEqual(["<transform:inner>", "<transform:outer>"]);

		await read?.definition.execute("call-1", { value: "ok" }, undefined, undefined, {} as never);
		expect(trace).toEqual(["outer:before", "inner:before", "read:base", "inner:after", "outer:after"]);
	});

	it("waits for a late base and re-resolves without accumulating wrappers", async () => {
		const trace: string[] = [];
		const transform = createTransform("dynamic", 1, "wrapper", trace);

		expect(resolveToolDefinitions([], [transform]).definitions.has("dynamic")).toBe(false);

		const base = createTool("dynamic", trace);
		for (let refresh = 0; refresh < 2; refresh++) {
			const resolved = resolveToolDefinitions([base], [transform]);
			await resolved.definitions
				.get("dynamic")
				?.definition.execute(`call-${refresh}`, { value: "ok" }, undefined, undefined, {} as never);
		}

		expect(trace).toEqual([
			"wrapper:before",
			"dynamic:base",
			"wrapper:after",
			"wrapper:before",
			"dynamic:base",
			"wrapper:after",
		]);
	});

	it("uses the last base definition before applying transforms", () => {
		const trace: string[] = [];
		const builtIn = createTool("shared", trace, "<builtin:shared>");
		const extension = createTool("shared", trace, "<extension:shared>");
		extension.definition.description = "extension winner";
		const sdk = createTool("shared", trace, "<sdk:shared>");
		sdk.definition.description = "sdk winner";

		const resolved = resolveToolDefinitions(
			[builtIn, extension, sdk],
			[createTransform("shared", 1, "wrapper", trace)],
		);

		expect(resolved.definitions.get("shared")?.definition.description).toBe("sdk winner");
		expect(resolved.definitions.get("shared")?.sourceInfo.path).toBe("<sdk:shared>");
	});

	it("exposes inherited renderer slots to transforms of replacement tools", () => {
		const trace: string[] = [];
		const builtIn = createTool("read", trace, "<builtin:read>");
		builtIn.definition.renderCall = () => new Text("built-in call", 0, 0);
		const replacement = createTool("read", trace, "<extension:read>");
		let inheritedRenderer: AnyToolDefinition["renderCall"];
		const transform: RegisteredToolTransform = {
			name: "read",
			registrationOrder: 1,
			sourceInfo: source("<transform:read>"),
			transform(current) {
				inheritedRenderer = current.renderCall;
				return current;
			},
		};

		const resolved = resolveToolDefinitions([builtIn, replacement], [transform], {
			rendererFallbacks: new Map([["read", builtIn.definition]]),
		});

		expect(inheritedRenderer).toBeDefined();
		expect(resolved.definitions.get("read")?.definition.renderCall).toBeDefined();
		expect(resolved.definitions.get("read")?.sourceInfo.path).toBe("<extension:read>");
	});

	it("removes only the tool whose transform throws", () => {
		const trace: string[] = [];
		const failure = new Error("policy setup failed");
		const transform: RegisteredToolTransform = {
			name: "broken",
			registrationOrder: 1,
			sourceInfo: source("<transform:broken>"),
			transform() {
				throw failure;
			},
		};

		const resolved = resolveToolDefinitions([createTool("broken", trace), createTool("healthy", trace)], [transform]);

		expect(resolved.definitions.has("broken")).toBe(false);
		expect(resolved.definitions.has("healthy")).toBe(true);
		expect(resolved.failures).toEqual([
			{
				toolName: "broken",
				registrationOrder: 1,
				sourceInfo: transform.sourceInfo,
				error: failure,
			},
		]);
	});

	it.each([
		{
			label: "name",
			change: (current: AnyToolDefinition) => ({ ...current, name: "other" }),
			message: "cannot change its name",
		},
		{
			label: "parameter schema",
			change: (current: AnyToolDefinition) => ({ ...current, parameters: Type.Object({ other: Type.String() }) }),
			message: "cannot replace its parameter schema",
		},
		{
			label: "incomplete definition",
			change: (current: AnyToolDefinition) => ({ ...current, execute: undefined }) as unknown as AnyToolDefinition,
			message: "must return a complete tool definition",
		},
		{
			label: "asynchronous result",
			change: (async (current: AnyToolDefinition) => current) as unknown as (
				current: AnyToolDefinition,
			) => AnyToolDefinition,
			message: "must be synchronous",
		},
	])("rejects a transformed $label", ({ change, message }) => {
		const trace: string[] = [];
		const transform: RegisteredToolTransform = {
			name: "read",
			registrationOrder: 1,
			sourceInfo: source("<transform:invalid>"),
			transform: change,
		};

		const resolved = resolveToolDefinitions([createTool("read", trace)], [transform]);

		expect(resolved.definitions.has("read")).toBe(false);
		expect(resolved.failures[0]?.error.message).toContain(message);
	});
});
