import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.registerTurnBoundaryRenderer((_current) => (context, theme) => {
		const source = context.isReplay ? "replay" : (context.source ?? "unknown");
		return new Text(theme.fg("dim", `── turn · ${source} ──`), 0, 0);
	});
}
