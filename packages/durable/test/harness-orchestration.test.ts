// The orchestration layer: a group of agents, each in its own conversation, and the one-shot drive that runs them
// to their answers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type AgentDriver,
	type AgentGroup,
	type AgentRequest,
	type AgentResult,
	createDrivers,
	createGroup,
	defineExtension,
	defineTask,
	joinAgents,
	MemoryStorage,
	OrchestratedAgent,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat, unanswered } from "./chat-support.ts";
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

/** Creates a group, drives it, and joins the answers. */
const Orchestrator = defineTask<
	{ agents: AgentRequest[] },
	{ phase: "run" } | { phase: "join"; drivers: readonly AgentDriver[] },
	AgentResult[]
>({
	name: "test.orchestrator",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				const group = await createGroup(tx, { ownerTaskId: task.id, agents: task.input.agents });
				const drivers = await createDrivers(tx, { ownerTaskId: task.id, group });
				return { status: "running", checkpoint: { phase: "join", drivers } };
			}, ctx),
		join: async (task, runtime, ctx) => {
			const results = await joinAgents(runtime, { drivers: task.state.checkpoint.drivers }, ctx);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: results } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
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
		const owned = await storage.scanConversations({ ownerTaskId: anchor }, 10, undefined, context);
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

	it("drives the group to its answers", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("The first answer.")]),
			fauxAssistantMessage([fauxText("The second answer.")]),
		]);
		setup.registry.install(defineExtension({ name: "orchestration", tasks: [Orchestrator, OrchestratedAgent] }));
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const orchestrator = await root.commit(
			(tx) =>
				tx.createTask(
					Orchestrator,
					{
						agents: [
							{ name: "reader", task: "What does the file say?" },
							{ name: "scout", task: "What is in the repository?" },
						],
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		const settled = await harness.waitForTask(orchestrator, context);
		expect(settled.state.outcome.status, JSON.stringify(setup.reports.map(String))).toBe("completed");
		const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];
		expect(results.map((result) => result.name)).toEqual(["reader", "scout"]);
		expect(results.map((result) => result.answer)).toEqual(["The first answer.", "The second answer."]);
		expect(results.every((result) => result.status === "answered")).toBe(true);
	});

	it("keeps one agent's failure from hiding the others' answers", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([
			fauxAssistantMessage([fauxText("The first answer.")]),
			fauxAssistantMessage([fauxText("The model failed.")], { stopReason: "error", errorMessage: "boom" }),
		]);
		setup.registry.install(defineExtension({ name: "orchestration", tasks: [Orchestrator, OrchestratedAgent] }));
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const orchestrator = await root.commit(
			(tx) =>
				tx.createTask(
					Orchestrator,
					{
						agents: [
							{ name: "reader", task: "What does the file say?" },
							{ name: "scout", task: "What is in the repository?" },
						],
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		const settled = await harness.waitForTask(orchestrator, context);
		expect(settled.state.outcome.status).toBe("completed");
		const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];
		expect(results.map((result) => result.status).sort()).toEqual(["answered", "failed"]);
		expect(results.find((result) => result.status === "answered")?.answer).toBe("The first answer.");
	});

	it("aborts the drivers and their conversations when the orchestrator is aborted", async () => {
		const setup = chatSetup();
		const blocked = unanswered();
		setup.faux.setResponses([blocked.step, blocked.step]);
		setup.registry.install(defineExtension({ name: "orchestration", tasks: [Orchestrator, OrchestratedAgent] }));
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const orchestrator = await root.commit(
			(tx) =>
				tx.createTask(
					Orchestrator,
					{
						agents: [
							{ name: "reader", task: "What does the file say?" },
							{ name: "scout", task: "What is in the repository?" },
						],
					},
					{ ownership: { kind: "conversation" } },
				),
			context,
		);
		harness.resume();
		await blocked.reached;
		await harness.abortTask(orchestrator, context);
		const settled = await harness.waitForTask(orchestrator, context);
		expect(settled.state.outcome.status).toBe("aborted");
		const inspection = await harness.inspect(context);
		expect(inspection.tasks.map((task) => task.state.kind)).toEqual([]);
	});

	it("resumes the group after a restart and answers once", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-orchestration-"));
		try {
			const setup = chatSetup();
			const blocked = unanswered();
			setup.faux.setResponses([blocked.step]);
			setup.registry.install(defineExtension({ name: "orchestration", tasks: [Orchestrator, OrchestratedAgent] }));
			const open = async () => openChat(await openNodeSqliteStorage(join(directory, "session.sqlite")), setup);
			const { harness, root } = await open();
			const orchestrator = await root.commit(
				(tx) =>
					tx.createTask(
						Orchestrator,
						{ agents: [{ name: "reader", task: "What does the file say?" }] },
						{ ownership: { kind: "conversation" } },
					),
				context,
			);
			harness.resume();
			await blocked.reached;
			await harness.close(context);
			// The next process answers the agent that was still working.
			setup.faux.setResponses([fauxAssistantMessage([fauxText("The answer.")])]);
			const reopened = await open();
			const settled = await reopened.harness.waitForTask(orchestrator, context);
			expect(settled.state.outcome.status).toBe("completed");
			const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];
			expect(results.map((result) => result.answer)).toEqual(["The answer."]);
			const group = await reopened.harness.getTask(orchestrator, context);
			expect(group?.state.status).toBe("terminal");
			// The answer was written once: the rerun did not ask the model twice.
			const storage = await openNodeSqliteStorage(join(directory, "session.sqlite"));
			const conversations = await storage.scanConversations({ ownerTaskId: orchestrator }, 10, undefined, context);
			for (const record of conversations.items) {
				const conversation = await reopened.harness.conversation(record.id, context);
				const entries = await conversation!.entries({}, 100, undefined, context);
				expect(entries.items.filter((entry) => entry.kind === "pi.assistant")).toHaveLength(1);
			}
			await reopened.harness.close(context);
			await storage.close(context);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
