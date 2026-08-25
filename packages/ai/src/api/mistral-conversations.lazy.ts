import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const mistralConversationsApi = (): IdentifiedProviderStreams<"mistral-conversations"> =>
	lazyApi("mistral-conversations", () => import("./mistral-conversations.ts"));
