import type { Component } from "@earendil-works/pi-tui";
import type { AnyToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../extensions/types.ts";

interface RenderLayerState {
	state: Record<string, unknown>;
	rowComponent?: Component;
	callComponent?: Component;
	resultComponent?: Component;
}

interface RenderScopeStore {
	layers: WeakMap<object, RenderLayerState>;
}

const rootRenderState = Symbol("pi.toolRenderRootState");
const renderScopeStores = new WeakMap<object, RenderScopeStore>();

type InternalRenderContext = ToolRenderContext & {
	[rootRenderState]?: object;
};

function getRenderScopeStore(rootState: object): RenderScopeStore {
	let store = renderScopeStores.get(rootState);
	if (!store) {
		store = { layers: new WeakMap() };
		renderScopeStores.set(rootState, store);
	}
	return store;
}

function getScopedRenderContext(
	context: ToolRenderContext,
	layerIdentity: object,
	slot: "rowComponent" | "callComponent" | "resultComponent",
): { context: ToolRenderContext; layer: RenderLayerState } {
	const internalContext = context as InternalRenderContext;
	const rootState = internalContext[rootRenderState] ?? context.state;
	if ((typeof rootState !== "object" && typeof rootState !== "function") || rootState === null) {
		throw new Error("Tool renderer state must be an object");
	}

	const store = getRenderScopeStore(rootState);
	let layer = store.layers.get(layerIdentity);
	if (!layer) {
		layer = { state: {} };
		store.layers.set(layerIdentity, layer);
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

/**
 * Give one renderer registration generation its own state and component slots.
 * Reloaded extensions receive new registration identities, so executable state
 * from an older generation cannot cross into their renderers.
 */
export function scopeToolRenderers(definition: AnyToolDefinition, layerIdentity: object): AnyToolDefinition {
	const renderRow = definition.renderRow;
	const renderCall = definition.renderCall;
	const renderResult = definition.renderResult;
	return {
		...definition,
		renderRow: renderRow
			? (component, theme, context) => {
					const scoped = getScopedRenderContext(context, layerIdentity, "rowComponent");
					const wrapped = renderRow(component, theme, scoped.context);
					scoped.layer.rowComponent = wrapped;
					return wrapped;
				}
			: undefined,
		renderCall: renderCall
			? (args, theme, context) => {
					const scoped = getScopedRenderContext(context, layerIdentity, "callComponent");
					const component = renderCall(args, theme, scoped.context);
					scoped.layer.callComponent = component;
					return component;
				}
			: undefined,
		renderResult: renderResult
			? (result, options: ToolRenderResultOptions, theme, context) => {
					const scoped = getScopedRenderContext(context, layerIdentity, "resultComponent");
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
		renderSpacing: definition.renderSpacing ?? fallback.renderSpacing,
		renderRow: definition.renderRow ?? fallback.renderRow,
		renderCall: definition.renderCall ?? fallback.renderCall,
		renderResult: definition.renderResult ?? fallback.renderResult,
	};
}
