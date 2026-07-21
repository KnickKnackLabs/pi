import type { Component } from "@earendil-works/pi-tui";
import type { AnyToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";

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

export function scopeToolRenderers(definition: AnyToolDefinition, layerKey: string): AnyToolDefinition {
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

export function inheritToolRenderers(
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
