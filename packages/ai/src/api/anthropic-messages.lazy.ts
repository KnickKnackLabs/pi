import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const anthropicMessagesApi = (): IdentifiedProviderStreams<"anthropic-messages"> =>
	lazyApi("anthropic-messages", () => import("./anthropic-messages.ts"));
