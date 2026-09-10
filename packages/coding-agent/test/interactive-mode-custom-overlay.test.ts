import { beforeAll, describe, expect, type TestContext, test, vi } from "vitest";
import { type Component, Container, type Focusable } from "../../tui/src/tui.ts";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class TestComponent implements Component, Focusable {
	focused = false;
	inputs: string[] = [];
	dispose = vi.fn();
	private readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return [this.label];
	}

	invalidate(): void {}
}

function createFixture({ onTestFinished }: TestContext) {
	const terminal = new VirtualTerminal(80, 24);
	const ui = new TuiMainScreen(terminal);
	const editor = new TestComponent("EDITOR");
	ui.addChild(editor);
	ui.setFocus(editor);
	ui.start();
	onTestFinished(() => ui.stop());

	const host = {
		ui,
		editor: { getText: () => "draft" },
		editorContainer: new Container(),
		keybindings: {},
	};
	const custom = (
		InteractiveMode.prototype as unknown as { showExtensionCustom: ExtensionUIContext["custom"] }
	).showExtensionCustom.bind(host);
	const render = async () => {
		await Promise.resolve();
		ui.renderNow();
		await terminal.waitForRender();
	};
	return { ui, terminal, editor, custom, render };
}

describe("custom overlay close ownership", () => {
	beforeAll(() => initTheme("dark"));

	test("closing a lower overlay preserves the upper overlay and its input focus", async (ctx) => {
		const { ui, terminal, editor, custom, render } = createFixture(ctx);
		const lower = new TestComponent("LOWER");
		const upper = new TestComponent("UPPER");
		let closeLower!: (result: string) => void;
		const result = custom<string>(
			(_tui, _theme, _keys, done) => {
				closeLower = done;
				return lower;
			},
			{ overlay: true },
		);
		await render();
		const upperHandle = ui.showOverlay(upper);

		closeLower("closed");
		closeLower("ignored");
		expect(await result).toBe("closed");
		await render();
		terminal.sendInput("x");

		expect(upper.focused).toBe(true);
		expect(upper.inputs).toEqual(["x"]);
		expect(lower.inputs).toEqual([]);
		expect(lower.dispose).toHaveBeenCalledTimes(1);
		expect(upper.dispose).not.toHaveBeenCalled();
		upperHandle.hide();
		expect(ui.hasOverlay()).toBe(false);
		expect(editor.focused).toBe(true);
	});

	test("closing inside the factory leaves an existing overlay alone", async (ctx) => {
		const { ui, custom, render } = createFixture(ctx);
		const existing = new TestComponent("EXISTING");
		const handle = ui.showOverlay(existing);
		const result = custom<string>(
			(_tui, _theme, _keys, done) => {
				done("not mounted");
				return new TestComponent("UNMOUNTED");
			},
			{ overlay: true },
		);

		expect(await result).toBe("not mounted");
		await render();
		expect(handle.getBounds()).toBeDefined();
		expect(existing.focused).toBe(true);
		handle.hide();
		expect(ui.hasOverlay()).toBe(false);
	});

	test("closing a pending factory neither hides another overlay nor mounts its late result", async (ctx) => {
		const { ui, custom, render } = createFixture(ctx);
		const existing = new TestComponent("EXISTING");
		const handle = ui.showOverlay(existing);
		let finishFactory!: (component: Component) => void;
		const pending = new Promise<Component>((resolve) => {
			finishFactory = resolve;
		});
		let close!: (result: string) => void;
		const result = custom<string>(
			(_tui, _theme, _keys, done) => {
				close = done;
				return pending;
			},
			{ overlay: true },
		);

		close("cancelled");
		expect(await result).toBe("cancelled");
		finishFactory(new TestComponent("LATE"));
		await render();
		expect(handle.getBounds()).toBeDefined();
		expect(existing.focused).toBe(true);
		handle.hide();
		expect(ui.hasOverlay()).toBe(false);
	});

	test("closing after its handle was removed does not remove a newer overlay", async (ctx) => {
		const { ui, custom, render } = createFixture(ctx);
		let close!: (result: string) => void;
		const result = custom<string>(
			(_tui, _theme, _keys, done) => {
				close = done;
				return new TestComponent("REMOVED");
			},
			{ overlay: true, onHandle: (handle) => handle.hide() },
		);
		await render();
		const newer = new TestComponent("NEWER");
		const handle = ui.showOverlay(newer);

		close("closed");
		expect(await result).toBe("closed");
		await render();
		expect(handle.getBounds()).toBeDefined();
		expect(newer.focused).toBe(true);
	});

	test("can close from onHandle without removing an overlay opened by that callback", async (ctx) => {
		const { ui, custom, render } = createFixture(ctx);
		const newer = new TestComponent("NEWER");
		let close!: (result: string) => void;
		const result = custom<string>(
			(_tui, _theme, _keys, done) => {
				close = done;
				return new TestComponent("CUSTOM");
			},
			{
				overlay: true,
				onHandle: () => {
					ui.showOverlay(newer);
					close("closed");
				},
			},
		);

		expect(await result).toBe("closed");
		await render();
		expect(newer.focused).toBe(true);
		ui.hideOverlay();
		expect(ui.hasOverlay()).toBe(false);
	});
});
