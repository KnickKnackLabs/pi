import { describe, expect, test } from "vitest";
import type { CustomMessageEntry, SessionMessageEntry } from "../src/core/session-manager.ts";
import { sessionMessageEntryToRenderContext } from "../src/core/session-message-render-context.ts";

function messageEntry(overrides: Partial<SessionMessageEntry> = {}): SessionMessageEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-08-25T00:00:00.000Z",
		message: { role: "user", content: "hello", timestamp: 1 },
		...overrides,
	};
}

function customMessageEntry(overrides: Partial<CustomMessageEntry> = {}): CustomMessageEntry {
	return {
		type: "custom_message",
		id: "custom-entry",
		parentId: null,
		timestamp: "2026-08-25T00:00:00.000Z",
		customType: "notice",
		content: "hello",
		display: true,
		...overrides,
	};
}

describe("sessionMessageEntryToRenderContext", () => {
	test("projects canonical entry identity and persisted segment metadata", () => {
		expect(
			sessionMessageEntryToRenderContext(
				messageEntry({ segmentNumber: 7, segmentKind: "agent", inputKind: "steer" }),
			),
		).toEqual({
			entryId: "entry-1",
			segmentNumber: 7,
			segmentKind: "agent",
			inputKind: "steer",
		});
	});

	test("keeps canonical identity for legacy entries without segment metadata", () => {
		expect(sessionMessageEntryToRenderContext(messageEntry({ id: "legacy-entry" }))).toEqual({
			entryId: "legacy-entry",
			segmentNumber: undefined,
			segmentKind: undefined,
			inputKind: undefined,
		});
	});

	test("projects canonical identity for persisted custom messages", () => {
		expect(sessionMessageEntryToRenderContext(customMessageEntry())).toEqual({
			entryId: "custom-entry",
		});
	});
});
