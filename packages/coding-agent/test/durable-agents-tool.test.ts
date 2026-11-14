import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { Check } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDurableAgentsTool } from "../src/core/durable/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-durable-agents-tool-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function createTool() {
	return createDurableAgentsTool({
		models: createModels(),
		sessionManager: SessionManager.inMemory(directory),
		agentDir: directory,
		cwd: directory,
	});
}

describe("the agents tool", () => {
	it("is inactive by default and runs its calls one at a time", () => {
		const tool = createTool();
		expect(tool.name).toBe("agents");
		expect(tool.defaultActive).toBe(false);
		expect(tool.executionMode).toBe("sequential");
	});

	it("takes a list of named agents with their tasks", () => {
		const tool = createTool();
		expect(Check(tool.parameters, { agents: [{ name: "reader", task: "read the file" }] })).toBe(true);
		expect(Check(tool.parameters, { agents: [{ name: "reader" }] })).toBe(false);
		expect(Check(tool.parameters, {})).toBe(false);
	});
});
