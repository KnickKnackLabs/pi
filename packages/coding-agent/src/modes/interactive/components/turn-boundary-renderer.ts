import type { Component } from "@earendil-works/pi-tui";
import type {
	TurnBoundaryContext,
	TurnBoundaryRenderer,
	TurnBoundaryRendererTransform,
} from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

function isComponent(value: unknown): value is Component {
	if (typeof value !== "object" || value === null) return false;
	const component = value as Partial<Component>;
	return typeof component.render === "function" && typeof component.invalidate === "function";
}

function tryRender(renderer: TurnBoundaryRenderer, context: TurnBoundaryContext, theme: Theme): Component | undefined {
	try {
		const component = renderer(context, theme);
		return isComponent(component) ? component : undefined;
	} catch {
		return undefined;
	}
}

export function composeTurnBoundaryRenderer(
	fallback: TurnBoundaryRenderer,
	transforms: readonly TurnBoundaryRendererTransform[],
): TurnBoundaryRenderer {
	let renderer = fallback;

	for (const transform of transforms) {
		const previous = renderer;
		try {
			const transformed = transform(previous);
			if (typeof transformed !== "function") continue;
			renderer = (context, theme) => tryRender(transformed, context, theme) ?? previous(context, theme);
		} catch {
			// Keep the previous renderer and continue with the next transform.
		}
	}

	const composed = renderer;
	if (composed === fallback) return fallback;

	return (context, theme) => {
		// Renderer transforms receive a snapshot so display code cannot mutate session or model state.
		let isolatedContext: TurnBoundaryContext;
		try {
			isolatedContext = structuredClone(context);
		} catch {
			return fallback(context, theme);
		}
		return tryRender(composed, isolatedContext, theme) ?? fallback(context, theme);
	};
}
