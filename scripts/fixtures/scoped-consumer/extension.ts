import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function consumerExtension(pi: ExtensionAPI) {
	pi.registerCommand("scoped-consumer-test", {
		description: "Check the published extension API",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			const selected = await ctx.ui.custom<string | undefined>(
				(_tui, _theme, _keybindings, done) => {
					done(undefined);
					return { render: () => [], invalidate: () => {} };
				},
				{ overlay: true },
			);
			if (selected !== undefined) ctx.ui.pasteToEditor(selected);
		},
	});
}
