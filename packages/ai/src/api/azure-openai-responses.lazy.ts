import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const azureOpenAIResponsesApi = (): IdentifiedProviderStreams<"azure-openai-responses"> =>
	lazyApi("azure-openai-responses", () => import("./azure-openai-responses.ts"));
