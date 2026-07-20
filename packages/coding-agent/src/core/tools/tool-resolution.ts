import type { Component } from "@earendil-works/pi-tui";
import type {
	AnyToolDefinition,
	RegisteredTool,
	RegisteredToolTransform,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../extensions/types.ts";
import type { SourceInfo } from "../source-info.ts";

export interface ResolvedToolDefinition extends RegisteredTool {
	transformedBy: SourceInfo[];
}

export interface ToolTransformFailure {
	toolName: string;
	registrationOrder: number;
	sourceInfo: SourceInfo;
	error: Error;
}

export interface ToolResolutionResult {
	definitions: Map<string, ResolvedToolDefinition>;
	failures: ToolTransformFailure[];
}

export interface ToolResolutionOptions {
	/** Built-in definitions used for the renderer slots inherited by same-name replacement tools. */
	rendererFallbacks?: ReadonlyMap<string, AnyToolDefinition>;
}

type TransformApplicationResult =
	| { definition: AnyToolDefinition; transformedBy: SourceInfo[]; failure?: never }
	| { definition?: never; transformedBy: SourceInfo[]; failure: ToolTransformFailure };

interface RenderLayerState {
	state: Record<string, unknown>;
	callComponent?: Component;
	resultComponent?: Component;
}

interface RenderScopeStore {
	layers: Map<string, RenderLayerState>;
}

const rootRenderState = Symbol("pi.toolRenderRootState");
const renderScopeStores = new WeakMap<object, RenderScopeStore>();

type InternalRenderContext = ToolRenderContext & {
	[rootRenderState]?: object;
};

function getRenderScopeStore(rootState: object): RenderScopeStore {
	let store = renderScopeStores.get(rootState);
	if (!store) {
		store = { layers: new Map() };
		renderScopeStores.set(rootState, store);
	}
	return store;
}

function getScopedRenderContext(
	context: ToolRenderContext,
	layerKey: string,
	slot: "callComponent" | "resultComponent",
): { context: ToolRenderContext; layer: RenderLayerState } {
	const internalContext = context as InternalRenderContext;
	const rootState = internalContext[rootRenderState] ?? context.state;
	if ((typeof rootState !== "object" && typeof rootState !== "function") || rootState === null) {
		throw new Error("Tool renderer state must be an object");
	}

	const store = getRenderScopeStore(rootState);
	let layer = store.layers.get(layerKey);
	if (!layer) {
		layer = { state: {} };
		store.layers.set(layerKey, layer);
	}

	return {
		context: {
			...context,
			state: layer.state,
			lastComponent: layer[slot],
			[rootRenderState]: rootState,
		} as InternalRenderContext,
		layer,
	};
}

function scopeToolRenderers(definition: AnyToolDefinition, layerKey: string): AnyToolDefinition {
	const renderCall = definition.renderCall;
	const renderResult = definition.renderResult;
	return {
		...definition,
		renderCall: renderCall
			? (args, theme, context) => {
					const scoped = getScopedRenderContext(context, layerKey, "callComponent");
					const component = renderCall(args, theme, scoped.context);
					scoped.layer.callComponent = component;
					return component;
				}
			: undefined,
		renderResult: renderResult
			? (result, options: ToolRenderResultOptions, theme, context) => {
					const scoped = getScopedRenderContext(context, layerKey, "resultComponent");
					const component = renderResult(result, options, theme, scoped.context);
					scoped.layer.resultComponent = component;
					return component;
				}
			: undefined,
	};
}

function resolveRendererSlots(
	definition: AnyToolDefinition,
	fallback: AnyToolDefinition | undefined,
): AnyToolDefinition {
	if (!fallback || fallback === definition) {
		return definition;
	}
	return {
		...definition,
		renderShell: definition.renderShell ?? fallback.renderShell,
		renderCall: definition.renderCall ?? fallback.renderCall,
		renderResult: definition.renderResult ?? fallback.renderResult,
	};
}

function invalidTransformResult(toolName: string, reason: string): Error {
	return new Error(`Tool transform for '${toolName}' ${reason}`);
}

function applyTransforms(base: RegisteredTool, transforms: RegisteredToolTransform[]): TransformApplicationResult {
	if (transforms.length === 0) {
		return { definition: base.definition, transformedBy: [] };
	}

	const baseName = base.definition.name;
	const baseParameters = base.definition.parameters;
	let current = scopeToolRenderers(base.definition, `${baseName}:base`);
	const transformedBy: SourceInfo[] = [];

	for (const registration of transforms) {
		try {
			const transformed = registration.transform(current);
			if (!transformed || typeof transformed !== "object") {
				throw invalidTransformResult(baseName, "must return a tool definition");
			}
			if ("then" in transformed && typeof transformed.then === "function") {
				throw invalidTransformResult(baseName, "must be synchronous");
			}
			if (transformed.name !== baseName) {
				throw invalidTransformResult(baseName, `cannot change its name to '${transformed.name}'`);
			}
			if (transformed.parameters !== baseParameters) {
				throw invalidTransformResult(baseName, "cannot replace its parameter schema");
			}
			if (
				typeof transformed.label !== "string" ||
				typeof transformed.description !== "string" ||
				typeof transformed.execute !== "function"
			) {
				throw invalidTransformResult(baseName, "must return a complete tool definition");
			}

			current = scopeToolRenderers(transformed, `${baseName}:transform:${registration.registrationOrder}`);
			transformedBy.push(registration.sourceInfo);
		} catch (error) {
			return {
				transformedBy,
				failure: {
					toolName: baseName,
					registrationOrder: registration.registrationOrder,
					sourceInfo: registration.sourceInfo,
					error: error instanceof Error ? error : new Error(String(error)),
				},
			};
		}
	}

	return { definition: current, transformedBy };
}

/**
 * Resolve the final tool definition for each name.
 *
 * Base definitions are ordered from lowest to highest precedence. Transforms are
 * applied to the winning base in registration order, with later transforms as
 * outer wrappers. A transform failure removes only the affected tool.
 */
export function resolveToolDefinitions(
	baseDefinitions: RegisteredTool[],
	registeredTransforms: RegisteredToolTransform[],
	options: ToolResolutionOptions = {},
): ToolResolutionResult {
	const basesByName = new Map<string, RegisteredTool>();
	for (const base of baseDefinitions) {
		basesByName.set(base.definition.name, base);
	}

	const transformsByName = new Map<string, RegisteredToolTransform[]>();
	for (const transform of [...registeredTransforms].sort((a, b) => a.registrationOrder - b.registrationOrder)) {
		const transforms = transformsByName.get(transform.name) ?? [];
		transforms.push(transform);
		transformsByName.set(transform.name, transforms);
	}

	const definitions = new Map<string, ResolvedToolDefinition>();
	const failures: ToolTransformFailure[] = [];
	for (const [name, base] of basesByName) {
		const resolvedBase = {
			...base,
			definition: resolveRendererSlots(base.definition, options.rendererFallbacks?.get(name)),
		};
		const resolved = applyTransforms(resolvedBase, transformsByName.get(name) ?? []);
		if (resolved.failure) {
			failures.push(resolved.failure);
			continue;
		}
		definitions.set(name, {
			definition: resolved.definition,
			sourceInfo: base.sourceInfo,
			transformedBy: resolved.transformedBy,
		});
	}

	return { definitions, failures };
}
