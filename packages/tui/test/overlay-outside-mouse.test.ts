import assert from "node:assert";
import { describe, it, type TestContext } from "node:test";
import type { Component, TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function createFixture(t: TestContext) {
	const terminal = new VirtualTerminal(40, 10);
	const tui = new TuiAltScreen(terminal, undefined, undefined, { copyOnSelect: false });
	const events: TuiMouseEvent[] = [];
	const inputs: string[] = [];
	const content = {
		render: () => Array.from({ length: 10 }, () => "underlying content"),
		invalidate: () => {},
		handleInput: (data: string) => inputs.push(data),
		handleMouse: (event: TuiMouseEvent) => {
			events.push(event);
			return { handled: true, focus: true };
		},
	};
	tui.addChild(content);
	tui.setFocus(content);
	tui.start();
	tui.renderNow();
	t.after(() => tui.stop());
	return { terminal, tui, events, inputs, content };
}

async function createSearchFixture(t: TestContext) {
	const fixture = createFixture(t);
	const { terminal, tui, content } = fixture;
	terminal.resize(120, 10);
	content.render = () => ["needle one", "middle", "needle two", "end"];
	tui.renderNow();
	terminal.sendInput("\x1b[102;6u");
	terminal.sendInput("needle");
	tui.renderNow();
	const viewport = await terminal.flushAndGetViewport();
	assert.ok(viewport.some((line) => line.includes("1/2")));
	const row = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
	const col = viewport[row]?.lastIndexOf("Enter") ?? -1;
	assert.ok(row >= 0 && col >= 0);
	return {
		...fixture,
		arrow: { row, col },
		pressArrow: `\x1b[<0;${col + 1};${row + 1}M`,
		releaseArrow: `\x1b[<0;${col + 1};${row + 1}m`,
	};
}

function overlayComponent(events: TuiMouseEvent[] = []): Component {
	return {
		render: () => ["overlay"],
		invalidate: () => {},
		handleMouse: (event) => {
			events.push(event);
			return { handled: true };
		},
	};
}

describe("fullscreen overlay outside mouse", () => {
	it("consumes a dismissed overlay's complete gesture and restores keyboard focus", (t) => {
		const { terminal, tui, events, inputs, content } = createFixture(t);
		const outside: TuiMouseEvent[] = [];
		const inside: TuiMouseEvent[] = [];
		const handle = tui.showOverlay(overlayComponent(inside), {
			row: 3,
			col: 10,
			width: 8,
			onOutsideMouse: (event) => {
				outside.push(event);
				handle.hide();
				return { handled: true };
			},
		});
		tui.renderNow();
		terminal.sendInput("\x1b[<0;2;2M");
		tui.renderNow();
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<3;3;2m");
		assert.strictEqual(outside.length, 1);
		assert.deepStrictEqual(
			{ x: outside[0]?.x, y: outside[0]?.y, width: outside[0]?.width, height: outside[0]?.height },
			{ x: -9, y: -2, width: 8, height: 1 },
		);
		assert.deepStrictEqual(inside, []);
		assert.strictEqual(events.length, 0);
		assert.strictEqual(tui.getFocusedComponent(), content);
		terminal.sendInput("x");
		assert.deepStrictEqual(inputs, ["x"]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		assert.deepStrictEqual(
			events.map((event) => event.type),
			["press", "release", "click"],
		);
		assert.strictEqual(events.at(-1)?.clickCount, 1);
	});

	it("does not synthesize a click after an outside press with no pointer movement", (t) => {
		const { terminal, tui, events } = createFixture(t);
		const handle = tui.showOverlay(overlayComponent(), {
			row: 3,
			width: 8,
			onOutsideMouse: () => {
				handle.hide();
				return { handled: true };
			},
		});
		tui.renderNow();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		assert.deepStrictEqual(events, []);
	});

	it("offers only the topmost eligible handler and leaves declined presses unchanged", (t) => {
		const { terminal, tui, events } = createFixture(t);
		const offered: string[] = [];
		tui.showOverlay(overlayComponent(), {
			row: 3,
			width: 8,
			onOutsideMouse: () => {
				offered.push("lower");
				return { handled: true };
			},
		});
		tui.showOverlay(overlayComponent(), {
			row: 5,
			width: 8,
			onOutsideMouse: () => {
				offered.push("upper");
				return { handled: false };
			},
		});
		tui.renderNow();
		terminal.sendInput("\x1b[<2;2;2M");
		terminal.sendInput("\x1b[<2;2;2m");
		assert.deepStrictEqual(offered, ["upper"]);
		assert.deepStrictEqual(
			events.map((event) => event.type),
			["press", "release", "click"],
		);
	});

	it("does not click through to a lower overlay when the upper one dismisses", (t) => {
		const { terminal, tui, events } = createFixture(t);
		const lowerEvents: TuiMouseEvent[] = [];
		const lower = overlayComponent(lowerEvents);
		tui.showOverlay(lower, { row: 1, col: 1, width: 8 });
		const upper = tui.showOverlay(overlayComponent(), {
			row: 3,
			col: 10,
			width: 8,
			onOutsideMouse: () => {
				upper.hide();
				return { handled: true };
			},
		});
		tui.renderNow();
		terminal.sendInput("\x1b[<0;2;2M");
		tui.renderNow();
		terminal.sendInput("\x1b[<0;2;2m");
		assert.strictEqual(tui.getFocusedComponent(), lower);
		assert.deepStrictEqual(lowerEvents, []);
		assert.deepStrictEqual(events, []);
	});

	it("keeps an inside drag with its component when it leaves the overlay", (t) => {
		const { terminal, tui, events } = createFixture(t);
		const inside: TuiMouseEvent[] = [];
		let outside = 0;
		tui.showOverlay(overlayComponent(inside), {
			row: 3,
			col: 10,
			width: 8,
			onOutsideMouse: () => {
				outside += 1;
				return { handled: true };
			},
		});
		tui.renderNow();
		terminal.sendInput("\x1b[<0;11;4M");
		terminal.sendInput("\x1b[<32;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		assert.strictEqual(outside, 0);
		assert.deepStrictEqual(
			inside.map((event) => event.type),
			["press", "drag", "release"],
		);
		assert.deepStrictEqual(events, []);
	});

	it("does not offer motion, orphaned releases, or wheel input as outside presses", (t) => {
		const { terminal, tui } = createFixture(t);
		let outside = 0;
		tui.showOverlay(overlayComponent(), {
			row: 3,
			width: 8,
			onOutsideMouse: () => {
				outside += 1;
				return { handled: true };
			},
		});
		tui.renderNow();
		for (const data of ["\x1b[<35;2;2M", "\x1b[<32;2;2M", "\x1b[<0;2;2m", "\x1b[<64;2;2M"]) {
			terminal.sendInput(data);
		}
		assert.strictEqual(outside, 0);
	});

	it("skips removed or hidden overlays before their scheduled repaint", (t) => {
		const { terminal, tui, events } = createFixture(t);
		for (const visibility of ["removed", "hidden", "predicate"] as const) {
			let visible = true;
			const handle = tui.showOverlay(overlayComponent(), {
				row: 3,
				width: 8,
				visible: () => visible,
				onOutsideMouse: () => {
					assert.fail("inactive overlay must not receive input");
				},
			});
			tui.renderNow();
			if (visibility === "removed") handle.hide();
			else if (visibility === "hidden") handle.setHidden(true);
			else visible = false;
			terminal.sendInput("\x1b[<0;2;2M");
			terminal.sendInput("\x1b[<0;2;2m");
			handle.hide();
		}
		assert.strictEqual(events.filter((event) => event.type === "click").length, 3);
	});

	it("uses resized bounds and visual focus order", (t) => {
		const { terminal, tui } = createFixture(t);
		const offered: string[] = [];
		const lower = tui.showOverlay(overlayComponent(), {
			anchor: "bottom-right",
			width: 8,
			onOutsideMouse: (event) => {
				offered.push("lower");
				assert.strictEqual(event.x, -11);
				assert.strictEqual(event.y, -4);
				return { handled: true };
			},
		});
		tui.showOverlay(overlayComponent(), {
			row: 3,
			width: 8,
			onOutsideMouse: () => {
				offered.push("upper");
				return { handled: true };
			},
		});
		lower.focus();
		terminal.resize(20, 6);
		tui.renderNow();
		assert.deepStrictEqual(lower.getBounds(), { col: 12, row: 5, width: 8, height: 1 });
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		assert.deepStrictEqual(offered, ["lower"]);
	});

	it("allows an outside handler to keep the overlay open without requesting a paint", async (t) => {
		const { terminal, tui, events } = createFixture(t);
		let renders = 0;
		const overlay = overlayComponent();
		overlay.render = () => {
			renders += 1;
			return ["overlay"];
		};
		const handle = tui.showOverlay(overlay, {
			row: 3,
			width: 8,
			onOutsideMouse: () => ({ handled: true, render: false }),
		});
		tui.renderNow();
		const before = renders;
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(renders, before);
		assert.ok(handle.getBounds());
		assert.deepStrictEqual(events, []);
	});

	it("retains consumption across overlay replacement but resets it on focus loss or restart", (t) => {
		const { terminal, tui, events } = createFixture(t);
		for (const reset of ["release", "focus", "restart"] as const) {
			const old = tui.showOverlay(overlayComponent(), {
				row: 3,
				width: 8,
				onOutsideMouse: () => {
					old.hide();
					return { handled: true };
				},
			});
			tui.renderNow();
			terminal.sendInput("\x1b[<0;2;2M");
			const replacement = tui.showOverlay(overlayComponent(), { row: 3, width: 8 });
			terminal.resize(30, 8);
			tui.renderNow();
			terminal.sendInput("\x1b[<32;3;2M");
			assert.strictEqual(events.length, 0);
			if (reset === "release") terminal.sendInput("\x1b[<0;3;2m");
			else if (reset === "focus") terminal.sendInput("\x1b[O");
			else {
				tui.stop();
				tui.start();
				tui.renderNow();
			}
			replacement.hide();
			terminal.sendInput("\x1b[<0;2;2M");
			terminal.sendInput("\x1b[<0;2;2m");
			assert.deepStrictEqual(
				events.map((event) => event.type),
				["press", "release", "click"],
			);
			events.length = 0;
		}
	});

	it("keeps a press over covered search arrows with the upper overlay", async (t) => {
		const { terminal, tui, arrow, pressArrow, releaseArrow } = await createSearchFixture(t);
		const search = tui.getFocusedComponent();
		const inside: TuiMouseEvent[] = [];
		let renders = 0;
		const menu: Component = {
			render: () => {
				renders += 1;
				return ["menu"];
			},
			invalidate: () => {},
			handleMouse: (event) => {
				inside.push(event);
				return { handled: true, focus: true, capture: true, render: true };
			},
		};
		const handle = tui.showOverlay(menu, { ...arrow, width: 8, nonCapturing: true });
		tui.renderNow();
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), search);
		const before = renders;
		terminal.sendInput(pressArrow);
		await terminal.waitForRender();
		assert.ok(
			terminal.getViewport().some((line) => line.includes("1/2")),
			"covered search must not navigate",
		);
		assert.strictEqual(tui.getFocusedComponent(), menu);
		assert.ok(renders > before, "the menu's render request must be applied");
		terminal.sendInput("\x1b[<32;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		assert.deepStrictEqual(
			inside.map((event) => event.type),
			["press", "drag", "release"],
		);

		handle.hide();
		tui.renderNow();
		terminal.sendInput(pressArrow);
		terminal.sendInput(releaseArrow);
		tui.renderNow();
		const viewport = await terminal.flushAndGetViewport();
		assert.ok(
			viewport.some((line) => line.includes("2/2")),
			"uncovered native search arrows still work",
		);
	});

	it("does not navigate covered search when the upper overlay declines the press", async (t) => {
		const { terminal, tui, arrow, pressArrow, releaseArrow } = await createSearchFixture(t);
		let presses = 0;
		tui.showOverlay(
			{
				render: () => ["menu"],
				invalidate: () => {},
				handleMouse: (event) => {
					if (event.type === "press") presses += 1;
					return { handled: false };
				},
			},
			{ ...arrow, width: 8 },
		);
		tui.renderNow();
		terminal.sendInput(pressArrow);
		terminal.sendInput(releaseArrow);
		tui.renderNow();
		assert.strictEqual(presses, 1);
		assert.ok((await terminal.flushAndGetViewport()).some((line) => line.includes("1/2")));
	});

	it("leaves overlays without an outside handler on the existing dispatch path", (t) => {
		const { terminal, tui, events } = createFixture(t);
		tui.showOverlay(overlayComponent(), { row: 3, width: 8 });
		tui.renderNow();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		assert.deepStrictEqual(
			events.map((event) => event.type),
			["press", "release", "click"],
		);
	});
});
