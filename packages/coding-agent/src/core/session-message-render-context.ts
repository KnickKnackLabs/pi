import type { SessionMessageRenderContext } from "./extensions/types.ts";
import type { CustomMessageEntry, SessionMessageEntry } from "./session-manager.ts";

/** Project persisted message-bearing entry identity and available segment metadata into renderer context. */
export function sessionMessageEntryToRenderContext(
	entry: SessionMessageEntry | CustomMessageEntry,
): SessionMessageRenderContext {
	if (entry.type === "custom_message") {
		return { entryId: entry.id };
	}
	return {
		entryId: entry.id,
		segmentNumber: entry.segmentNumber,
		segmentKind: entry.segmentKind,
		inputKind: entry.inputKind,
	};
}
