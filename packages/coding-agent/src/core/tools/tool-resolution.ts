import type { AnyToolDefinition, RegisteredTool, RegisteredToolTransform } from "../extensions/types.ts";
import type { SourceInfo } from "../source-info.ts";
import { inheritToolRenderers, scopeToolRenderers } from "./tool-renderer-composition.ts";

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
			definition: inheritToolRenderers(base.definition, options.rendererFallbacks?.get(name)),
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
