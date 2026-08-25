import type { IdentifiedProviderStreams } from "../types.ts";
import { lazyApi } from "./lazy.ts";

export const googleVertexApi = (): IdentifiedProviderStreams<"google-vertex"> =>
	lazyApi("google-vertex", () => import("./google-vertex.ts"));
