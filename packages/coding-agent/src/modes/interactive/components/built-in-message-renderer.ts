import type {
	BuiltInMessageByRole,
	BuiltInMessageRenderer,
	BuiltInMessageRendererTransform,
	BuiltInMessageRenderOptions,
	BuiltInMessageRenderResult,
	BuiltInMessageRole,
} from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

function isRenderResult(value: unknown): value is BuiltInMessageRenderResult {
	if (typeof value !== "object" || value === null) return false;
	const result = value as Partial<BuiltInMessageRenderResult>;
	const component = result.component as Partial<BuiltInMessageRenderResult["component"]> | undefined;
	return (
		(result.renderShell === "default" || result.renderShell === "self") &&
		typeof component?.render === "function" &&
		typeof component.invalidate === "function"
	);
}

function tryRender<Role extends BuiltInMessageRole>(
	renderer: BuiltInMessageRenderer<Role>,
	message: BuiltInMessageByRole[Role],
	options: BuiltInMessageRenderOptions,
	theme: Theme,
): BuiltInMessageRenderResult | undefined {
	try {
		const result = renderer(message, options, theme);
		return isRenderResult(result) ? result : undefined;
	} catch {
		return undefined;
	}
}

export function composeBuiltInMessageRenderer<Role extends BuiltInMessageRole>(
	fallback: BuiltInMessageRenderer<Role>,
	transforms: readonly BuiltInMessageRendererTransform<Role>[],
): BuiltInMessageRenderer<Role> {
	let renderer = fallback;

	for (const transform of transforms) {
		const previous = renderer;
		try {
			const transformed = transform(previous);
			if (typeof transformed !== "function") continue;
			renderer = (message, options, theme) =>
				tryRender(transformed, message, options, theme) ?? previous(message, options, theme);
		} catch {
			// Keep the previous renderer and continue with the next transform.
		}
	}

	const composed = renderer;
	return (message, options, theme) =>
		tryRender(composed, message, options, theme) ?? fallback(message, options, theme);
}
