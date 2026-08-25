import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BashExecutionMessage, CustomMessage } from "../../src/core/messages.ts";
import { exportSessionToJsonl } from "../../src/core/session-export.ts";
import {
	type AgentSegmentMetadata,
	type AppendMessageOptions,
	SEGMENT_TRACKING_VERSION,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.ts";

describe("SessionManager conversation segment tracking", () => {
	let tempDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-segment-tracking-"));
		sessionsDir = join(tempDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function messageEntries(session: SessionManager): SessionMessageEntry[] {
		return session.getEntries().filter((entry): entry is SessionMessageEntry => entry.type === "message");
	}

	function writeSession(
		path: string,
		options: { tracked: boolean; segments?: Array<{ number: number; kind: "user" | "agent" }> },
	): void {
		const header = {
			type: "session",
			version: 3,
			id: options.tracked ? "tracked-source" : "legacy-source",
			timestamp: "2026-08-24T00:00:00.000Z",
			cwd: tempDir,
			...(options.tracked ? { segmentTrackingVersion: SEGMENT_TRACKING_VERSION } : {}),
		};
		const segments = options.segments ?? [];
		const entries = segments.map((segment, index) => ({
			type: "message",
			id: `entry-${index + 1}`,
			parentId: index === 0 ? null : `entry-${index}`,
			timestamp: `2026-08-24T00:00:0${index + 1}.000Z`,
			segmentNumber: segment.number,
			segmentKind: segment.kind,
			message: { role: "user", content: `message ${index + 1}`, timestamp: index + 1 },
		}));
		writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}

	it("opts new sessions into one shared user and agent segment sequence", () => {
		const session = SessionManager.inMemory(tempDir);
		expect(session.getHeader()?.segmentTrackingVersion).toBe(SEGMENT_TRACKING_VERSION);

		const userSegment = session.allocateSegment("user")!;
		const agentSegment = session.allocateSegment("agent")!;
		session.appendMessage(
			{ role: "user", content: "hello", timestamp: 1 },
			{ segment: userSegment, inputKind: "normal" },
		);
		session.appendMessage(fauxAssistantMessage("hi"), { segment: agentSegment });

		expect(messageEntries(session)).toMatchObject([
			{ segmentNumber: 1, segmentKind: "user", inputKind: "normal", message: { role: "user" } },
			{ segmentNumber: 2, segmentKind: "agent", message: { role: "assistant" } },
		]);
	});

	it("reconciles supplied numbers with future allocations while allowing repeated segment entries", () => {
		const session = SessionManager.inMemory(tempDir);
		session.appendMessage(
			{ role: "user", content: "externally numbered", timestamp: 1 },
			{
				segment: { segmentNumber: 999, segmentKind: "user" },
				inputKind: "normal",
			},
		);

		const agentSegment = session.allocateSegment("agent")!;
		expect(agentSegment).toEqual({ segmentNumber: 1000, segmentKind: "agent" });
		session.appendMessage(fauxAssistantMessage("first"), { segment: agentSegment });
		session.appendMessage(fauxAssistantMessage("second"), { segment: agentSegment });
		expect(session.allocateSegment("user")).toEqual({ segmentNumber: 1001, segmentKind: "user" });
	});

	it("copies only validated segment fields from public append input", () => {
		const session = SessionManager.inMemory(tempDir);
		const assistant = fauxAssistantMessage("trusted message");
		const forgedSegment = {
			segmentNumber: 7,
			segmentKind: "agent",
			type: "custom",
			id: "forged-id",
			parentId: "forged-parent",
			timestamp: "forged-time",
			message: { role: "user", content: "forged message", timestamp: 1 },
			inputKind: "steer",
			leafIdAfter: "forged-leaf",
		} as unknown as AgentSegmentMetadata;

		const entryId = session.appendMessage(assistant, { segment: forgedSegment });
		const entry = session.getEntry(entryId);
		expect(entryId).not.toBe("forged-id");
		expect(entry).toMatchObject({
			type: "message",
			id: entryId,
			parentId: null,
			message: assistant,
			segmentNumber: 7,
			segmentKind: "agent",
		});
		expect(entry?.timestamp).not.toBe("forged-time");
		expect(entry).not.toHaveProperty("inputKind");
		expect(entry).not.toHaveProperty("leafIdAfter");
	});

	it("restores the maximum from the whole file and never reuses a branched-away number", () => {
		const session = SessionManager.create(tempDir, sessionsDir, { id: "tracked-reload" });
		const firstSegment = session.allocateSegment("user")!;
		const firstId = session.appendMessage(
			{ role: "user", content: "first", timestamp: 1 },
			{ segment: firstSegment, inputKind: "normal" },
		);
		const secondSegment = session.allocateSegment("agent")!;
		session.appendMessage(fauxAssistantMessage("second"), { segment: secondSegment });
		const thirdSegment = session.allocateSegment("user")!;
		session.appendMessage(
			{ role: "user", content: "third", timestamp: 3 },
			{ segment: thirdSegment, inputKind: "normal" },
		);

		session.branch(firstId);
		const replacementSegment = session.allocateSegment("user")!;
		expect(replacementSegment.segmentNumber).toBe(4);
		session.appendMessage(
			{ role: "user", content: "replacement", timestamp: 4 },
			{ segment: replacementSegment, inputKind: "normal" },
		);

		const reopened = SessionManager.open(session.getSessionFile()!, sessionsDir);
		expect(reopened.allocateSegment("agent")).toEqual({ segmentNumber: 5, segmentKind: "agent" });
	});

	it("ignores segment-shaped metadata on non-message entries when restoring the maximum", () => {
		const path = join(sessionsDir, "non-message-metadata.jsonl");
		const entries = [
			{
				type: "session",
				version: 3,
				id: "non-message-source",
				timestamp: "2026-08-24T00:00:00.000Z",
				cwd: tempDir,
				segmentTrackingVersion: SEGMENT_TRACKING_VERSION,
			},
			{
				type: "custom",
				id: "custom-entry",
				parentId: null,
				timestamp: "2026-08-24T00:00:01.000Z",
				customType: "test",
				data: {},
				segmentNumber: 99,
				segmentKind: "agent",
			},
		];
		writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const session = SessionManager.open(path, sessionsDir);
		expect(session.allocateSegment("user")).toEqual({ segmentNumber: 1, segmentKind: "user" });
	});

	it("preserves tracking mode and copied maximum in branched sessions", () => {
		const trackedPath = join(sessionsDir, "tracked.jsonl");
		writeSession(trackedPath, {
			tracked: true,
			segments: [
				{ number: 1, kind: "user" },
				{ number: 7, kind: "agent" },
			],
		});
		const tracked = SessionManager.open(trackedPath, sessionsDir);
		tracked.createBranchedSession("entry-2");
		expect(tracked.getHeader()?.segmentTrackingVersion).toBe(SEGMENT_TRACKING_VERSION);
		expect(tracked.allocateSegment("user")).toEqual({ segmentNumber: 8, segmentKind: "user" });

		const legacyPath = join(sessionsDir, "legacy.jsonl");
		writeSession(legacyPath, { tracked: false, segments: [{ number: 9, kind: "user" }] });
		const legacy = SessionManager.open(legacyPath, sessionsDir);
		legacy.createBranchedSession("entry-1");
		expect(legacy.getHeader()?.segmentTrackingVersion).toBeUndefined();
		expect(legacy.allocateSegment("user")).toBeUndefined();
	});

	it("preserves tracking mode and copied maximum when forking into a new session", () => {
		const trackedPath = join(sessionsDir, "tracked-fork.jsonl");
		writeSession(trackedPath, {
			tracked: true,
			segments: [
				{ number: 2, kind: "user" },
				{ number: 6, kind: "agent" },
			],
		});
		const trackedForkDir = join(tempDir, "tracked-fork");
		const trackedFork = SessionManager.forkFrom(trackedPath, tempDir, trackedForkDir, { id: "tracked-fork" });
		expect(trackedFork.getHeader()?.segmentTrackingVersion).toBe(SEGMENT_TRACKING_VERSION);
		expect(trackedFork.allocateSegment("user")).toEqual({ segmentNumber: 7, segmentKind: "user" });

		const legacyPath = join(sessionsDir, "legacy-fork.jsonl");
		writeSession(legacyPath, { tracked: false, segments: [{ number: 12, kind: "agent" }] });
		const legacyForkDir = join(tempDir, "legacy-fork");
		const legacyFork = SessionManager.forkFrom(legacyPath, tempDir, legacyForkDir, { id: "legacy-fork" });
		expect(legacyFork.getHeader()?.segmentTrackingVersion).toBeUndefined();
		expect(legacyFork.allocateSegment("agent")).toBeUndefined();
	});

	it("preserves tracked and legacy modes in exported JSONL headers", () => {
		const trackedExport = exportSessionToJsonl(
			SessionManager.inMemory(tempDir),
			join(tempDir, "tracked-export.jsonl"),
		);
		const trackedHeader = JSON.parse(readFileSync(trackedExport, "utf8").split("\n")[0]);
		expect(trackedHeader.segmentTrackingVersion).toBe(SEGMENT_TRACKING_VERSION);

		const legacyPath = join(sessionsDir, "legacy-export-source.jsonl");
		writeSession(legacyPath, { tracked: false });
		const legacy = SessionManager.open(legacyPath, sessionsDir);
		const legacyExport = exportSessionToJsonl(legacy, join(tempDir, "legacy-export.jsonl"));
		const legacyHeader = JSON.parse(readFileSync(legacyExport, "utf8").split("\n")[0]);
		expect(legacyHeader).not.toHaveProperty("segmentTrackingVersion");
	});

	it("validates supplied segment metadata while allowing metadata-free messages", () => {
		const session = SessionManager.inMemory(tempDir);
		const user = { role: "user" as const, content: "hello", timestamp: 1 };
		const assistant = fauxAssistantMessage("hi");
		const toolResult = {
			role: "toolResult" as const,
			toolCallId: "call-1",
			toolName: "test",
			content: [{ type: "text" as const, text: "result" }],
			isError: false,
			timestamp: 2,
		};
		const invalid = (segment: unknown, inputKind?: string): AppendMessageOptions =>
			({ segment, inputKind }) as AppendMessageOptions;

		expect(() => session.appendMessage(user, invalid({ segmentNumber: 0, segmentKind: "user" }, "normal"))).toThrow(
			"segmentNumber must be a positive safe integer",
		);
		expect(() => session.appendMessage(user, invalid(undefined, "normal"))).toThrow(
			"inputKind requires conversation segment metadata",
		);
		expect(() => session.appendMessage(user, invalid(undefined, ""))).toThrow(
			"inputKind requires conversation segment metadata",
		);
		expect(() => session.appendMessage(user, invalid(null))).toThrow(
			"inputKind requires conversation segment metadata",
		);
		expect(() => session.appendMessage(user, invalid({ segmentNumber: 1, segmentKind: "agent" }, "normal"))).toThrow(
			"Normal and follow-up input require a user segment",
		);
		expect(() => session.appendMessage(user, invalid({ segmentNumber: 1, segmentKind: "user" }, "steer"))).toThrow(
			"Steering input requires an agent segment",
		);
		expect(() => session.appendMessage(user, invalid({ segmentNumber: 1, segmentKind: "user" }))).toThrow(
			"User segment metadata requires inputKind normal, follow-up, or steer",
		);
		expect(() => session.appendMessage(assistant, invalid({ segmentNumber: 2, segmentKind: "user" }))).toThrow(
			"Assistant and tool-result messages require an agent segment without inputKind",
		);
		expect(() =>
			session.appendMessage(toolResult, invalid({ segmentNumber: 2, segmentKind: "agent" }, "steer")),
		).toThrow("Assistant and tool-result messages require an agent segment without inputKind");

		const custom: CustomMessage = {
			role: "custom",
			customType: "test",
			content: "custom",
			display: true,
			timestamp: 3,
		};
		const bash: BashExecutionMessage = {
			role: "bashExecution",
			command: "true",
			output: "",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 4,
		};
		expect(() => session.appendMessage(custom, invalid({ segmentNumber: 3, segmentKind: "agent" }))).toThrow(
			"custom messages cannot carry conversation segment metadata",
		);
		expect(() => session.appendMessage(bash, invalid({ segmentNumber: 3, segmentKind: "agent" }))).toThrow(
			"bashExecution messages cannot carry conversation segment metadata",
		);

		session.appendMessage(custom);
		session.appendMessage(bash);
		session.appendCustomEntry("test", {});
		for (const entry of session.getEntries().slice(-3)) {
			expect(entry).not.toHaveProperty("segmentNumber");
			expect(entry).not.toHaveProperty("segmentKind");
			expect(entry).not.toHaveProperty("inputKind");
		}
	});

	it("keeps legacy sessions untracked and rejects supplied segment metadata", () => {
		const legacyPath = join(sessionsDir, "legacy-append.jsonl");
		writeSession(legacyPath, { tracked: false });
		const legacy = SessionManager.open(legacyPath, sessionsDir);

		expect(legacy.allocateSegment("user")).toBeUndefined();
		expect(() =>
			legacy.appendMessage(
				{ role: "user", content: "legacy", timestamp: 1 },
				{
					segment: { segmentNumber: 1, segmentKind: "user" },
					inputKind: "normal",
				},
			),
		).toThrow("Conversation segment metadata requires a tracked session");
		legacy.appendMessage({ role: "user", content: "legacy", timestamp: 1 });
		expect(messageEntries(legacy).at(-1)).not.toHaveProperty("segmentNumber");
		expect(messageEntries(legacy).at(-1)).not.toHaveProperty("segmentKind");
		expect(messageEntries(legacy).at(-1)).not.toHaveProperty("inputKind");
	});
});
