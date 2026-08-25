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

/** Select a live catalog model with the capabilities required by the shared Cloudflare gateway integration tests. */
export function getCloudflareAiGatewayCompletionsModel(): Model<"openai-completions"> | undefined {
	const models = getBuiltinModels("cloudflare-ai-gateway") as readonly Model<Api>[];
	return models.find(
		(model): model is Model<"openai-completions"> => model.api === "openai-completions" && model.reasoning,
	);
}
