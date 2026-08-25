import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const piMessagesApi = (): IdentifiedProviderStreams<"pi-messages"> =>
	lazyApi("pi-messages", () => import("./pi-messages.ts"));
