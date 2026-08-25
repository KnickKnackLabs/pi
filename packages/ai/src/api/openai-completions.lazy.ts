import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICompletionsApi = (): IdentifiedProviderStreams<"openai-completions"> =>
	lazyApi("openai-completions", () => import("./openai-completions.ts"));
