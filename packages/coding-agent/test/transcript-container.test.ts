import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { TranscriptContainer } from "../src/modes/interactive/transcript-container.ts";

function createTranscript() {
	const onError = vi.fn<(error: unknown) => void>();
	return { transcript: new TranscriptContainer(onError), onError };
}

describe("TranscriptContainer", () => {
	it("notifies synchronously after clearing rows, including an already empty transcript", () => {
		const { transcript } = createTranscript();
		const rowsSeen: number[] = [];
		transcript.addChild(new Text("old row", 0, 0));
		transcript.onReset(() => rowsSeen.push(transcript.children.length));

		transcript.clear();
		expect(rowsSeen).toEqual([0]);
		transcript.clear();
		expect(rowsSeen).toEqual([0, 0]);
	});

	it("does not notify on adding, rendering, invalidating, or removing an individual row", () => {
		const { transcript } = createTranscript();
		const handler = vi.fn();
		const row = new Text("row", 0, 0);
		transcript.onReset(handler);

		transcript.addChild(row);
		expect(transcript.render(40).map((line) => line.trimEnd())).toEqual(["row"]);
		transcript.invalidate();
		transcript.removeChild(row);
		expect(handler).not.toHaveBeenCalled();
	});

	it("gives duplicate callbacks independent, idempotent subscriptions", () => {
		const { transcript } = createTranscript();
		const handler = vi.fn();
		const unsubscribe = transcript.onReset(handler);
		transcript.onReset(handler);

		unsubscribe();
		unsubscribe();
		transcript.clear();
		expect(handler).toHaveBeenCalledOnce();
	});

	it("defers new subscriptions and skips ones removed during notification", () => {
		const { transcript } = createTranscript();
		const added = vi.fn();
		const removed = vi.fn();
		let unsubscribe = () => {};
		transcript.onReset(() => {
			unsubscribe();
			transcript.onReset(added);
		});
		unsubscribe = transcript.onReset(removed);

		transcript.clear();
		expect(added).not.toHaveBeenCalled();
		expect(removed).not.toHaveBeenCalled();
		transcript.clear();
		expect(added).toHaveBeenCalledOnce();
	});

	it("retires all subscriptions without changing rows or notifying", () => {
		const { transcript } = createTranscript();
		const oldHandler = vi.fn();
		const newHandler = vi.fn();
		const row = new Text("row", 0, 0);
		transcript.addChild(row);
		const unsubscribe = transcript.onReset(oldHandler);

		transcript.clearResetListeners();
		expect(transcript.children).toEqual([row]);
		expect(oldHandler).not.toHaveBeenCalled();
		transcript.onReset(newHandler);
		unsubscribe();
		transcript.clear();
		expect(oldHandler).not.toHaveBeenCalled();
		expect(newHandler).toHaveBeenCalledOnce();
	});

	it("skips remaining subscriptions when teardown occurs inside a handler", () => {
		const { transcript } = createTranscript();
		const retired = vi.fn();
		transcript.onReset(() => transcript.clearResetListeners());
		transcript.onReset(retired);

		transcript.clear();
		expect(retired).not.toHaveBeenCalled();
	});

	it("reports a throwing handler and still runs the remaining handlers", () => {
		const { transcript, onError } = createTranscript();
		const error = new Error("cleanup failed");
		const remaining = vi.fn();
		transcript.onReset(() => {
			throw error;
		});
		transcript.onReset(remaining);

		transcript.clear();
		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
		expect(remaining).toHaveBeenCalledOnce();
	});

	it("does not await accidental async handlers, but observes their rejection", async () => {
		const { transcript, onError } = createTranscript();
		const error = new Error("late cleanup failure");
		let reject!: (reason: Error) => void;
		const pending = new Promise<void>((_resolve, rejectPromise) => {
			reject = rejectPromise;
		});
		const remaining = vi.fn();
		transcript.onReset(() => pending);
		transcript.onReset(remaining);

		transcript.clear();
		expect(remaining).toHaveBeenCalledOnce();
		expect(onError).not.toHaveBeenCalled();
		reject(error);
		await Promise.resolve();
		expect(onError).toHaveBeenCalledExactlyOnceWith(error);
	});
});
