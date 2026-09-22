import { type Component, getKeybindings, setKeybindings, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type FullscreenExitOutput, SettingsManager } from "../src/core/settings-manager.ts";
import type { SettingsSelectorComponent } from "../src/modes/interactive/components/settings-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { TranscriptContainer } from "../src/modes/interactive/transcript-container.ts";

// Exercise the host methods without starting a terminal or an agent session.
type LifecycleMode = {
	createExtensionUIContext(): ExtensionUIContext;
	rebuildChatFromMessages(): void;
	showSettingsSelector(): void;
	resetExtensionUI(): void;
	stop(output: FullscreenExitOutput): void;
};

function createMode() {
	const chatContainer = new TranscriptContainer(vi.fn());
	return Object.assign(Object.create(InteractiveMode.prototype) as LifecycleMode, {
		chatContainer,
		renderSessionEntries: vi.fn(() => {
			chatContainer.addChild(new Text("replacement", 0, 0));
		}),
		runtimeHost: {
			session: {
				sessionManager: { buildContextEntries: () => [] },
				settingsManager: { getShowTerminalProgress: () => false },
			},
		},
		ui: { hideOverlay: vi.fn(), requestRender: vi.fn(), mode: "regular" },
		clearExtensionTerminalInputListeners: vi.fn(),
		setExtensionFooter: vi.fn(),
		setExtensionHeader: vi.fn(),
		clearExtensionWidgets: vi.fn(),
		footerDataProvider: { clearExtensionStatuses: vi.fn(), dispose: vi.fn() },
		footer: { invalidate: vi.fn(), dispose: vi.fn() },
		setCustomEditorComponent: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
		defaultEditor: {},
		updateTerminalTitle: vi.fn(),
		setWorkingIndicator: vi.fn(),
		setHiddenThinkingLabel: vi.fn(),
		disposeActiveSelector: vi.fn(),
		clearStatusIndicator: vi.fn(),
		themeController: { disableAutoSync: vi.fn() },
		stopInteractiveTui: vi.fn(),
		unregisterSignalHandlers: vi.fn(),
		isInitialized: true,
	});
}

function createSettingsMode() {
	const mode = createMode();
	const settings = SettingsManager.inMemory({ outputPad: 1, showCacheMissNotices: false });
	const session = Object.assign(mode.runtimeHost.session, {
		settingsManager: settings,
		isStreaming: false,
		modelRuntime: { getAvailableSnapshot: () => [] },
	});
	Object.assign(mode.themeController, {
		getThemeSelection: () => "dark",
		getTerminalTheme: () => "dark",
	});
	const showSelector =
		vi.fn<(create: (done: () => void) => { component: SettingsSelectorComponent; focus: Component }) => void>();
	Object.assign(mode, { showSelector });
	mode.showSettingsSelector();
	const selector = showSelector.mock.calls[0][0](vi.fn()).component;
	return { mode, session, settings, list: selector.getSettingsList() };
}

describe("InteractiveMode transcript reset subscription", () => {
	it("notifies through ctx.ui before constructing replacements during a rebuild", () => {
		const mode = createMode();
		const ui = mode.createExtensionUIContext();
		const order: string[] = [];
		const rowsAtReset: number[] = [];
		mode.chatContainer.addChild(new Text("old", 0, 0));
		ui.onTranscriptReset(() => {
			rowsAtReset.push(mode.chatContainer.children.length);
			order.push("reset");
		});
		mode.renderSessionEntries.mockImplementation(() => {
			order.push("construct");
			mode.chatContainer.addChild(new Text("replacement", 0, 0));
		});

		mode.rebuildChatFromMessages();
		expect(order).toEqual(["reset", "construct"]);
		expect(mode.chatContainer.children).toHaveLength(1);
		mode.rebuildChatFromMessages();
		expect(order).toEqual(["reset", "construct", "reset", "construct"]);
		expect(rowsAtReset).toEqual([0, 0]);
	});

	describe("settings-driven rebuilds", () => {
		let previousKeybindings: ReturnType<typeof getKeybindings>;
		beforeEach(() => {
			initTheme("dark");
			previousKeybindings = getKeybindings();
			setKeybindings(new KeybindingsManager());
		});
		afterEach(() => setKeybindings(previousKeybindings));

		it.each(["output-padding", "cache-miss-notices"])("notifies before replacements when changing %s", (setting) => {
			const { mode, settings, list } = createSettingsMode();
			const oldRow = new Text("old", 0, 0);
			mode.chatContainer.addChild(oldRow);
			const observations: Array<{ rows: number; constructions: number }> = [];
			const reset = vi.fn(() => {
				observations.push({
					rows: mode.chatContainer.children.length,
					constructions: mode.renderSessionEntries.mock.calls.length,
				});
			});
			mode.createExtensionUIContext().onTranscriptReset(reset);

			list.selectItem(setting);
			list.handleInput("\r");

			expect(reset).toHaveBeenCalledOnce();
			expect(observations).toEqual([{ rows: 0, constructions: 0 }]);
			expect(mode.renderSessionEntries).toHaveBeenCalledOnce();
			expect(mode.chatContainer.children).not.toContain(oldRow);
			expect(settings.getOutputPad()).toBe(setting === "output-padding" ? 0 : 1);
			expect(settings.getShowCacheMissNotices()).toBe(setting === "cache-miss-notices");
		});

		it("does not notify for output padding during streaming or a non-rebuilding display setting", () => {
			const { mode, session, settings, list } = createSettingsMode();
			const row = new Text("retained", 0, 0);
			mode.chatContainer.addChild(row);
			const reset = vi.fn();
			mode.createExtensionUIContext().onTranscriptReset(reset);
			session.isStreaming = true;

			list.selectItem("output-padding");
			list.handleInput("\r");
			expect(settings.getOutputPad()).toBe(0);
			expect(mode.ui.requestRender).toHaveBeenCalledOnce();

			session.isStreaming = false;
			list.selectItem("mermaid-rendering");
			list.handleInput("\r");
			expect(mode.ui.requestRender).toHaveBeenCalledTimes(2);
			expect(mode.renderSessionEntries).not.toHaveBeenCalled();
			expect(reset).not.toHaveBeenCalled();
			expect(mode.chatContainer.children).toEqual([row]);
		});
	});

	it("exposes an idempotent unsubscribe through ctx.ui", () => {
		const mode = createMode();
		const handler = vi.fn();
		const unsubscribe = mode.createExtensionUIContext().onTranscriptReset(handler);

		unsubscribe();
		unsubscribe();
		mode.rebuildChatFromMessages();
		expect(handler).not.toHaveBeenCalled();
	});

	it("retires old subscriptions on extension UI teardown and accepts new session subscriptions", () => {
		const mode = createMode();
		const retired = vi.fn();
		const current = vi.fn();
		mode.createExtensionUIContext().onTranscriptReset(retired);

		mode.resetExtensionUI();
		mode.rebuildChatFromMessages();
		expect(retired).not.toHaveBeenCalled();

		mode.createExtensionUIContext().onTranscriptReset(current);
		mode.rebuildChatFromMessages();
		expect(retired).not.toHaveBeenCalled();
		expect(current).toHaveBeenCalledOnce();
	});

	it("retires subscriptions before stopping the TUI without notifying them", () => {
		const mode = createMode();
		const handler = vi.fn();
		mode.createExtensionUIContext().onTranscriptReset(handler);
		mode.stopInteractiveTui.mockImplementation(() => mode.chatContainer.clear());

		mode.stop("resume-hint");
		expect(mode.stopInteractiveTui).toHaveBeenCalledExactlyOnceWith("resume-hint");
		mode.chatContainer.clear();
		expect(handler).not.toHaveBeenCalled();
	});
});
