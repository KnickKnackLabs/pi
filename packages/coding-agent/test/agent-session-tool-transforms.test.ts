import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	AnyToolDefinition,
	ExtensionAPI,
	NamedToolDefinition,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const dynamicParameters = Type.Object({});
type DynamicTool = NamedToolDefinition<"dynamic_tool", ToolDefinition<typeof dynamicParameters, { version: number }>>;

function registerDynamicTool(pi: ExtensionAPI, version: number): void {
	pi.registerTool({
		name: "dynamic_tool",
		label: "Dynamic Tool",
		description: `dynamic base ${version}`,
		promptSnippet: "Run dynamic behavior",
		parameters: dynamicParameters,
		async execute() {
			return {
				content: [{ type: "text" as const, text: `version ${version}` }],
				details: { version },
			};
		},
	});
}

describe("AgentSession tool transforms", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-transform-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	async function createSession(options: {
		extensionFactories: Array<(pi: ExtensionAPI) => void>;
		customTools?: AnyToolDefinition[];
		excludeTools?: string[];
		settingsManager?: SettingsManager;
	}) {
		const settingsManager = options.settingsManager ?? SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: options.extensionFactories,
		});
		await resourceLoader.reload();
		const result = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			customTools: options.customTools,
			excludeTools: options.excludeTools,
		});
		return result.session;
	}

	it("wraps the configured built-in definition instead of reconstructing it", async () => {
		const trace: string[] = [];
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		settingsManager.setShellCommandPrefix("export PI_CONFIGURED_TOOL=preserved");
		const session = await createSession({
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool("bash", (current) => ({
						...current,
						async execute(toolCallId, params, signal, onUpdate, context) {
							trace.push("transform");
							return current.execute(toolCallId, params, signal, onUpdate, context);
						},
					}));
				},
			],
		});

		const bash = session.getToolDefinition("bash")!;
		const result = await bash.execute(
			"configured-call",
			{ command: 'printf %s "$PI_CONFIGURED_TOOL"' },
			undefined,
			undefined,
			{} as never,
		);

		expect(trace).toEqual(["transform"]);
		expect(result.content).toEqual([{ type: "text", text: "preserved" }]);
		expect(session.getAllTools().find((tool) => tool.name === "bash")?.transformedBy).toMatchObject([
			{ path: "<inline:1>", source: "inline" },
		]);
		session.dispose();
	});

	it("refreshes an active tool when a transform is registered after initialization", async () => {
		let registerTransform: (() => void) | undefined;
		const session = await createSession({
			extensionFactories: [
				(pi) => {
					registerTransform = () => {
						pi.registerTool("read", (current) => ({
							...current,
							description: `late: ${current.description}`,
						}));
					};
				},
			],
		});
		const originalDescription = session.getToolDefinition("read")!.description;
		expect(session.getActiveToolNames()).toContain("read");

		registerTransform!();

		expect(session.getToolDefinition("read")?.description).toBe(`late: ${originalDescription}`);
		expect(session.getActiveToolNames()).toContain("read");
		expect(session.getAllTools().find((tool) => tool.name === "read")?.transformedBy).toHaveLength(1);
		session.dispose();
	});

	it("composes transforms across extensions in registration order", async () => {
		const session = await createSession({
			extensionFactories: [
				(pi) => {
					pi.registerTool("read", (current) => ({
						...current,
						description: `inner(${current.description})`,
					}));
				},
				(pi) => {
					pi.registerTool("read", (current) => ({
						...current,
						description: `outer(${current.description})`,
					}));
				},
			],
		});

		const info = session.getAllTools().find((tool) => tool.name === "read")!;
		expect(info.description).toMatch(/^outer\(inner\(/);
		expect(info.transformedBy.map((item) => item.path)).toEqual(["<inline:1>", "<inline:2>"]);
		session.dispose();
	});

	it("keeps transforms across late registration and base replacement without stacking", async () => {
		let registerBase: ((version: number) => void) | undefined;
		const calls: number[] = [];
		const session = await createSession({
			extensionFactories: [
				(pi) => {
					pi.registerTool<DynamicTool>("dynamic_tool", (current) => ({
						...current,
						description: `wrapped: ${current.description}`,
						async execute(toolCallId, params, signal, onUpdate, context) {
							const result = await current.execute(toolCallId, params, signal, onUpdate, context);
							calls.push(result.details.version);
							return result;
						},
					}));
					registerBase = (version) => registerDynamicTool(pi, version);
				},
			],
		});

		expect(session.getToolDefinition("dynamic_tool")).toBeUndefined();
		registerBase!(1);
		expect(session.getToolDefinition("dynamic_tool")?.description).toBe("wrapped: dynamic base 1");
		expect(session.getActiveToolNames()).toContain("dynamic_tool");
		await session.getToolDefinition("dynamic_tool")!.execute("dynamic-1", {}, undefined, undefined, {} as never);

		registerBase!(2);
		expect(session.getToolDefinition("dynamic_tool")?.description).toBe("wrapped: dynamic base 2");
		await session.getToolDefinition("dynamic_tool")!.execute("dynamic-2", {}, undefined, undefined, {} as never);

		expect(calls).toEqual([1, 2]);
		session.dispose();
	});

	it("applies extension transforms to SDK custom tools while preserving SDK ownership", async () => {
		const sdkParameters = Type.Object({ value: Type.String() });
		type SdkTool = NamedToolDefinition<"sdk_tool", ToolDefinition<typeof sdkParameters, { value: string }>>;
		const sdkTool: ToolDefinition<typeof sdkParameters, { value: string }> = {
			name: "sdk_tool",
			label: "SDK Tool",
			description: "sdk base",
			parameters: sdkParameters,
			async execute(_toolCallId, params) {
				return { content: [{ type: "text", text: params.value }], details: { value: params.value } };
			},
		};
		const session = await createSession({
			customTools: [sdkTool],
			extensionFactories: [
				(pi) => {
					pi.registerTool<SdkTool>("sdk_tool", (current) => ({
						...current,
						description: `wrapped: ${current.description}`,
					}));
				},
			],
		});

		const info = session.getAllTools().find((tool) => tool.name === "sdk_tool");
		expect(info?.description).toBe("wrapped: sdk base");
		expect(info?.sourceInfo).toMatchObject({ path: "<sdk:sdk_tool>", source: "sdk" });
		expect(info?.transformedBy).toMatchObject([{ path: "<inline:1>", source: "inline" }]);
		session.dispose();
	});

	it("does not make excluded tools visible just because a transform targets them", async () => {
		const session = await createSession({
			excludeTools: ["read"],
			extensionFactories: [
				(pi) => {
					pi.registerTool("read", (current) => ({ ...current, description: "should stay excluded" }));
				},
			],
		});

		expect(session.getToolDefinition("read")).toBeUndefined();
		expect(session.getAllTools().some((tool) => tool.name === "read")).toBe(false);
		expect(session.getActiveToolNames()).not.toContain("read");
		session.dispose();
	});

	it("rebuilds transforms from the stable base on reload", async () => {
		let suffix = "first";
		const session = await createSession({
			extensionFactories: [
				(pi) => {
					pi.registerTool("read", (current) => ({
						...current,
						description: `${current.description} [${suffix}]`,
					}));
				},
			],
		});
		const baseDescription = session.getToolDefinition("read")!.description.replace(" [first]", "");
		expect(session.getToolDefinition("read")?.description).toBe(`${baseDescription} [first]`);

		suffix = "second";
		await session.reload();

		expect(session.getToolDefinition("read")?.description).toBe(`${baseDescription} [second]`);
		expect(session.getAllTools().find((tool) => tool.name === "read")?.transformedBy).toHaveLength(1);
		session.dispose();
	});

	it("reports a transform failure once and disables only the affected tool", async () => {
		let refreshRegistry: (() => void) | undefined;
		const session = await createSession({
			extensionFactories: [
				(pi) => {
					pi.registerTool("read", () => {
						throw new Error("read policy failed");
					});
					refreshRegistry = () => registerDynamicTool(pi, 1);
				},
			],
		});
		const errors: Array<{ event: string; error: string }> = [];

		await session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(session.getToolDefinition("read")).toBeUndefined();
		expect(session.getToolDefinition("bash")).toBeDefined();
		expect(errors).toMatchObject([{ event: "tool_transform", error: "read policy failed" }]);

		refreshRegistry!();
		expect(errors).toHaveLength(1);

		await session.reload();
		expect(errors).toHaveLength(2);
		expect(errors[1]).toMatchObject({ event: "tool_transform", error: "read policy failed" });
		session.dispose();
	});
});
