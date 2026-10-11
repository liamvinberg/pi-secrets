import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piSecrets from "./index.js";

function registerIntoStub(): ToolDefinition {
	let registered: ToolDefinition | undefined;
	const pi = {
		registerTool: (definition: ToolDefinition) => {
			registered = definition;
		},
		on: () => {},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;

	piSecrets(pi);
	if (!registered) throw new Error("pi-secrets did not register a tool");
	return registered;
}

describe("request_secret registration", () => {
	test("declares sequential execution so parallel calls cannot clobber the prompt", () => {
		// pi runs every tool call in one assistant message concurrently unless one of
		// them is sequential. Two concurrent prompts fight over the TUI's single
		// custom-component slot: the loser is removed from the container, its `done`
		// callback is never called, and the turn hangs with that secret uncaptured.
		const tool = registerIntoStub();

		expect(tool.name).toBe("request_secret");
		expect(tool.executionMode).toBe("sequential");
	});
});
