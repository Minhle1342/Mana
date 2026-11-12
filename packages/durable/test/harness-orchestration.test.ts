// The orchestration layer: a group of agents, each in its own conversation, and the one-shot drive that runs them
// to their answers.
import { describe, expect, it } from "vitest";
import {
	AgentDoc,
	type AgentGroup,
	createGroup,
	defineTask,
	Harness,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { context } from "./session-support.ts";
import { openTasks } from "./task-support.ts";

/** A background anchor that owns a group's conversations, the way p2's subagents are owned. */
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "test.orchestration-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, ctx) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), ctx),
	},
	abort: (_anchor, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

describe("the orchestration layer", () => {
	it("creates a group: one conversation per agent, owned by the named task", async () => {
		const storage = new MemoryStorage();
		const { harness } = await openTasks(storage, [Anchor]);
		const root = await harness.root(context);
		const anchor = await root.commit(
			(tx) => tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true }),
			context,
		);
		const group: AgentGroup = await harness.commit(
			(tx) =>
				createGroup(tx, {
					ownerTaskId: anchor,
					agents: [
						{ name: "reader", task: "Read the file." },
						{ name: "scout", task: "Scout the repository." },
					],
				}),
			context,
		);
		expect(group.agents.map((agent) => agent.name)).toEqual(["reader", "scout"]);
		expect(new Set(group.agents.map((agent) => agent.conversationId)).size).toBe(2);
		for (const agent of group.agents) {
			expect(await harness.conversation(agent.conversationId, context)).toBeDefined();
		}
		const owned = await storage.scanConversations({ ownerTaskId: anchor }, 10);
		expect(owned.items.map((record) => record.id).sort()).toEqual(
			group.agents.map((agent) => agent.conversationId).sort(),
		);
	});

	it("gives each conversation the profile its agent asked for", async () => {
		const storage = new MemoryStorage();
		const { harness } = await openTasks(storage, [Anchor]);
		const root = await harness.root(context);
		const anchor = await root.commit(
			(tx) => tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true }),
			context,
		);
		const group = await harness.commit(
			(tx) =>
				createGroup(tx, {
					ownerTaskId: anchor,
					agents: [
						{ name: "reader", task: "Read the file.", agent: { cwd: "/work/read" } },
						{ name: "scout", task: "Scout the repository." },
					],
				}),
			context,
		);
		const reader = group.agents[0]!;
		const scout = group.agents[1]!;
		expect((await harness.snapshot(AgentDoc, reader.conversationId, context))?.cwd).toBe("/work/read");
		expect((await harness.snapshot(AgentDoc, scout.conversationId, context))?.cwd).toBeUndefined();
	});
});
