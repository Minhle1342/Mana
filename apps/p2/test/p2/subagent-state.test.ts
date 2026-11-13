// The worker's rule for a child's state: a run that was stopped mid-tool left a tool call behind, which is
// not an answer.
import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { AssistantEntry, type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { childState } from "../../plugins/subagents/contract.worker.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** An assistant entry with the given stop reason: the cast is here because the entry's model message is wider than the rule reads. */
const entry = (stopReason: string): EntryRecord =>
	({
		id: 1 as EntryId,
		conversationId: ROOT_CONVERSATION_ID,
		kind: AssistantEntry.kind,
		model: [
			{
				role: "assistant",
				content: [{ type: "text", text: "text" }],
				api: "anthropic-messages",
				provider: "faux",
				model: "faux-1",
				usage,
				stopReason,
				timestamp: 1,
			},
		],
	}) as unknown as EntryRecord;

nodeTest("a child's state follows its run and its answer", () => {
	// A live run: working, whatever it wrote last.
	assert.equal(childState({ running: true, latest: entry("stop") }), "working");
	// A finished answer: answered.
	assert.equal(childState({ running: false, latest: entry("stop") }), "answered");
	// A run stopped mid-tool: the tool call is not an answer.
	assert.equal(childState({ running: false, latest: entry("toolUse") }), "idle");
	// An errored or aborted run: idle.
	assert.equal(childState({ running: false, latest: entry("error") }), "idle");
	assert.equal(childState({ running: false, latest: entry("aborted") }), "idle");
	// Nothing yet: idle.
	assert.equal(childState({ running: false, latest: undefined }), "idle");
});
