import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSessionToJsonl } from "../../src/core/session-export.ts";
import { SessionManager, type SessionMessageEntry, TURN_TRACKING_VERSION } from "../../src/core/session-manager.ts";

describe("SessionManager turn tracking", () => {
	let tempDir: string;
	let sessionsDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-turn-tracking-"));
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
		options: { tracked: boolean; turns?: Array<{ number: number; kind: "user" | "agent" }> },
	): void {
		const header = {
			type: "session",
			version: 3,
			id: options.tracked ? "tracked-source" : "legacy-source",
			timestamp: "2026-08-24T00:00:00.000Z",
			cwd: tempDir,
			...(options.tracked ? { turnTrackingVersion: TURN_TRACKING_VERSION } : {}),
		};
		const turns = options.turns ?? [];
		const entries = turns.map((turn, index) => ({
			type: "message",
			id: `entry-${index + 1}`,
			parentId: index === 0 ? null : `entry-${index}`,
			timestamp: `2026-08-24T00:00:0${index + 1}.000Z`,
			turnNumber: turn.number,
			turnKind: turn.kind,
			message: { role: "user", content: `message ${index + 1}`, timestamp: index + 1 },
		}));
		writeFileSync(path, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	}

	it("opts new sessions into one shared user and agent sequence", () => {
		const session = SessionManager.inMemory(tempDir);
		expect(session.getHeader()?.turnTrackingVersion).toBe(TURN_TRACKING_VERSION);

		const userTurn = session.allocateTurn("user");
		const agentTurn = session.allocateTurn("agent");
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 }, { turn: userTurn, inputKind: "normal" });
		session.appendMessage(fauxAssistantMessage("hi"), { turn: agentTurn });

		expect(messageEntries(session)).toMatchObject([
			{ turnNumber: 1, turnKind: "user", inputKind: "normal", message: { role: "user" } },
			{ turnNumber: 2, turnKind: "agent", message: { role: "assistant" } },
		]);
	});

	it("restores the maximum from the whole file and never reuses a branched-away number", () => {
		const session = SessionManager.create(tempDir, sessionsDir, { id: "tracked-reload" });
		const firstTurn = session.allocateTurn("user")!;
		const firstId = session.appendMessage(
			{ role: "user", content: "first", timestamp: 1 },
			{ turn: firstTurn, inputKind: "normal" },
		);
		const secondTurn = session.allocateTurn("agent")!;
		session.appendMessage(fauxAssistantMessage("second"), { turn: secondTurn });
		const thirdTurn = session.allocateTurn("user")!;
		session.appendMessage({ role: "user", content: "third", timestamp: 3 }, { turn: thirdTurn, inputKind: "normal" });

		session.branch(firstId);
		const replacementTurn = session.allocateTurn("user")!;
		expect(replacementTurn.turnNumber).toBe(4);
		session.appendMessage(
			{ role: "user", content: "replacement", timestamp: 4 },
			{ turn: replacementTurn, inputKind: "normal" },
		);

		const reopened = SessionManager.open(session.getSessionFile()!, sessionsDir);
		expect(reopened.allocateTurn("agent")).toEqual({ turnNumber: 5, turnKind: "agent" });
	});

	it("preserves tracking mode and copied maximum in branched sessions", () => {
		const trackedPath = join(sessionsDir, "tracked.jsonl");
		writeSession(trackedPath, {
			tracked: true,
			turns: [
				{ number: 1, kind: "user" },
				{ number: 7, kind: "agent" },
			],
		});
		const tracked = SessionManager.open(trackedPath, sessionsDir);
		tracked.createBranchedSession("entry-2");
		expect(tracked.getHeader()?.turnTrackingVersion).toBe(TURN_TRACKING_VERSION);
		expect(tracked.allocateTurn("user")).toEqual({ turnNumber: 8, turnKind: "user" });

		const legacyPath = join(sessionsDir, "legacy.jsonl");
		writeSession(legacyPath, { tracked: false, turns: [{ number: 9, kind: "user" }] });
		const legacy = SessionManager.open(legacyPath, sessionsDir);
		legacy.createBranchedSession("entry-1");
		expect(legacy.getHeader()?.turnTrackingVersion).toBeUndefined();
		expect(legacy.allocateTurn("user")).toBeUndefined();
	});

	it("preserves tracking mode and copied maximum when forking into a new session", () => {
		const trackedPath = join(sessionsDir, "tracked-fork.jsonl");
		writeSession(trackedPath, {
			tracked: true,
			turns: [
				{ number: 2, kind: "user" },
				{ number: 6, kind: "agent" },
			],
		});
		const trackedForkDir = join(tempDir, "tracked-fork");
		const trackedFork = SessionManager.forkFrom(trackedPath, tempDir, trackedForkDir, { id: "tracked-fork" });
		expect(trackedFork.getHeader()?.turnTrackingVersion).toBe(TURN_TRACKING_VERSION);
		expect(trackedFork.allocateTurn("user")).toEqual({ turnNumber: 7, turnKind: "user" });

		const legacyPath = join(sessionsDir, "legacy-fork.jsonl");
		writeSession(legacyPath, { tracked: false, turns: [{ number: 12, kind: "agent" }] });
		const legacyForkDir = join(tempDir, "legacy-fork");
		const legacyFork = SessionManager.forkFrom(legacyPath, tempDir, legacyForkDir, { id: "legacy-fork" });
		expect(legacyFork.getHeader()?.turnTrackingVersion).toBeUndefined();
		expect(legacyFork.allocateTurn("agent")).toBeUndefined();
	});

	it("preserves tracked and legacy modes in exported JSONL headers", () => {
		const trackedExport = exportSessionToJsonl(
			SessionManager.inMemory(tempDir),
			join(tempDir, "tracked-export.jsonl"),
		);
		const trackedHeader = JSON.parse(readFileSync(trackedExport, "utf8").split("\n")[0]);
		expect(trackedHeader.turnTrackingVersion).toBe(TURN_TRACKING_VERSION);

		const legacyPath = join(sessionsDir, "legacy-export-source.jsonl");
		writeSession(legacyPath, { tracked: false });
		const legacy = SessionManager.open(legacyPath, sessionsDir);
		const legacyExport = exportSessionToJsonl(legacy, join(tempDir, "legacy-export.jsonl"));
		const legacyHeader = JSON.parse(readFileSync(legacyExport, "utf8").split("\n")[0]);
		expect(legacyHeader).not.toHaveProperty("turnTrackingVersion");
	});

	it("keeps legacy sessions untracked when appending new messages", () => {
		const legacyPath = join(sessionsDir, "legacy-append.jsonl");
		writeSession(legacyPath, { tracked: false });
		const legacy = SessionManager.open(legacyPath, sessionsDir);

		expect(legacy.allocateTurn("user")).toBeUndefined();
		legacy.appendMessage({ role: "user", content: "legacy", timestamp: 1 });
		expect(messageEntries(legacy).at(-1)).not.toHaveProperty("turnNumber");
		expect(messageEntries(legacy).at(-1)).not.toHaveProperty("turnKind");
		expect(messageEntries(legacy).at(-1)).not.toHaveProperty("inputKind");
	});
});
