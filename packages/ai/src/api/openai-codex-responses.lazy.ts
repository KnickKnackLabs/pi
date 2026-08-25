import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const openAICodexResponsesApi = (): IdentifiedProviderStreams<"openai-codex-responses"> =>
	lazyApi("openai-codex-responses", () => import("./openai-codex-responses.ts"));
