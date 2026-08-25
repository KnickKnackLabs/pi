import { getBuiltinModels } from "../src/providers/all.ts";
import type { Api, Model } from "../src/types.ts";

export function hasCloudflareWorkersAICredentials(): boolean {
	return !!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID;
}

export function hasCloudflareAiGatewayCredentials(): boolean {
	return (
		!!process.env.CLOUDFLARE_API_KEY && !!process.env.CLOUDFLARE_ACCOUNT_ID && !!process.env.CLOUDFLARE_GATEWAY_ID
	);
}

function getCloudflareAiGatewayModels(): readonly Model<Api>[] {
	return getBuiltinModels("cloudflare-ai-gateway") as readonly Model<Api>[];
}

/** Select any live Cloudflare gateway completions model for generic integration coverage. */
export function getCloudflareAiGatewayCompletionsModel(): Model<"openai-completions"> | undefined {
	return getCloudflareAiGatewayModels().find(
		(model): model is Model<"openai-completions"> => model.api === "openai-completions",
	);
}

/** Select a live Cloudflare gateway completions model for reasoning-specific integration coverage. */
export function getCloudflareAiGatewayReasoningCompletionsModel(): Model<"openai-completions"> | undefined {
	return getCloudflareAiGatewayModels().find(
		(model): model is Model<"openai-completions"> => model.api === "openai-completions" && model.reasoning,
	);
}
