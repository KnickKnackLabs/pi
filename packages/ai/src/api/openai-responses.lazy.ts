import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAIResponsesApi = (): IdentifiedProviderStreams<"openai-responses"> =>
	lazyApi("openai-responses", () => import("./openai-responses.ts"));
