import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const scope = process.env.PI_CONSUMER_SCOPE;
const version = process.env.PI_CONSUMER_VERSION;
assert.ok(scope && version, "Expected scope and version must be supplied");

assert.ok(process.env.PI_CONSUMER_LOCKFILE, "Consumer lockfile path must be supplied");
const lock = JSON.parse(readFileSync(process.env.PI_CONSUMER_LOCKFILE, "utf8"));
let forkCount = 0;
for (const [location, entry] of Object.entries(lock.packages)) {
	const importName = location.split("node_modules/").at(-1);
	if (!importName.startsWith("@earendil-works/")) continue;
	const basename = importName.split("/")[1];
	assert.equal(entry.name, `@${scope}/${basename}`, `${location} did not resolve to the fork`);
	assert.equal(entry.version, version, `${location} has a different fork version`);
	forkCount++;
}
assert.ok(forkCount > 1, "Expected coding-agent and sibling fork packages");
assert.equal(typeof Agent, "function");
assert.equal(typeof Type.Object, "function");
assert.equal(typeof createAgentSession, "function");
assert.deepEqual(new Text("Fork consumer", 0, 0).render(40), ["Fork consumer".padEnd(40)]);
console.log(`Verified ${forkCount} fork packages, core imports, and Text rendering; no provider requests made.`);
