import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleGenerativeAIApi = (): IdentifiedProviderStreams<"google-generative-ai"> =>
	lazyApi("google-generative-ai", () => import("./google-generative-ai.ts"));
