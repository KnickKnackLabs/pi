import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Spacer, Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerBuiltInMessageRenderer("user", (current) => (message, options, theme) => {
		const rendered = current(message, { ...options, outputPad: 0 }, theme);
		const card = new Box(options.outputPad, 1, (line) => theme.bg("userMessageBg", line));
		card.addChild(new Text(theme.fg("muted", new Date(message.timestamp).toLocaleTimeString()), 0, 0));
		card.addChild(new Spacer(1));
		card.addChild(rendered.component);
		return { component: card, renderShell: "self" };
	});

	pi.registerBuiltInMessageRenderer("assistant", (current) => (message, options, theme) => {
		const rendered = current(message, { ...options, outputPad: 0 }, theme);
		const card = new Box(options.outputPad, 1, (line) => theme.bg("customMessageBg", line));
		const status = options.isStreaming ? "streaming" : message.stopReason;
		card.addChild(new Text(theme.fg("muted", `${message.model} · ${status}`), 0, 0));
		card.addChild(new Spacer(1));
		card.addChild(rendered.component);
		return { component: card, renderShell: "self" };
	});
}
