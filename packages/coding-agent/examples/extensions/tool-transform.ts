/**
 * Tool Transform Example - Add policy around an existing tool without replacing it.
 *
 * This extension wraps the fully configured `read` tool. It preserves the
 * original execution, parameter schema, rich results, and renderers while
 * adding access logging and a small deny policy.
 *
 * Usage:
 *   pi -e ./tool-transform.ts
 */

import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const LOG_FILE = join(getAgentDir(), "read-access.log");

const BLOCKED_PATTERNS = [
	/\.env$/,
	/\.env\..+$/,
	/secrets?\.(json|yaml|yml|toml)$/i,
	/credentials?\.(json|yaml|yml|toml)$/i,
	/\/\.ssh\//,
	/\/\.aws\//,
	/\/\.gnupg\//,
];

function isBlockedPath(path: string): boolean {
	const normalizedPath = path.replaceAll("\\", "/");
	return BLOCKED_PATTERNS.some((pattern) => pattern.test(normalizedPath));
}

async function logAccess(path: string, allowed: boolean, reason?: string): Promise<void> {
	const status = allowed ? "ALLOWED" : "BLOCKED";
	const suffix = reason ? ` (${reason})` : "";
	const line = `[${new Date().toISOString()}] ${status}: ${path}${suffix}\n`;

	try {
		await withFileMutationQueue(LOG_FILE, () => appendFile(LOG_FILE, line));
	} catch {
		// Auditing should not make the underlying read tool unavailable.
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerTool("read", (current) => ({
		...current,
		label: "read (audited)",
		description: `${current.description} Access is logged; common credential files are blocked.`,
		async execute(toolCallId, params, signal, onUpdate, context) {
			const absolutePath = resolve(context.cwd, params.path);
			if (isBlockedPath(absolutePath)) {
				await logAccess(absolutePath, false, "matches blocked pattern");
				return {
					content: [
						{
							type: "text",
							text: `Access denied: "${params.path}" matches the audited read policy.`,
						},
					],
					details: undefined,
				};
			}

			await logAccess(absolutePath, true);
			return current.execute(toolCallId, params, signal, onUpdate, context);
		},
	}));

	pi.registerCommand("read-policy", {
		description: "Show the resolved read tool and its transform chain",
		handler: async (_args, context) => {
			const readTool = pi.getAllTools().find((tool) => tool.name === "read");
			if (!readTool) {
				context.ui.notify("The read tool is not available", "warning");
				return;
			}
			const transforms = readTool.transformedBy.map((source) => source.path).join(" -> ") || "none";
			context.ui.notify(`read base: ${readTool.sourceInfo.path}\ntransforms: ${transforms}`, "info");
		},
	});

	pi.registerCommand("read-log", {
		description: "View the last 20 audited read entries",
		handler: async (_args, context) => {
			try {
				const lines = readFileSync(LOG_FILE, "utf8").trim().split("\n").slice(-20);
				context.ui.notify(`Recent file access:\n${lines.join("\n")}`, "info");
			} catch {
				context.ui.notify("No access log found", "info");
			}
		},
	});
}
