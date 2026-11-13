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
	type TaskId,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { chatSetup, openChat, unanswered } from "./chat-support.ts";
import { context } from "./session-support.ts";
import { aborted, openTasks } from "./task-support.ts";

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
	{ agents: AgentRequest[]; groupId: string },
	{ phase: "run" } | { phase: "join"; drivers: readonly AgentDriver[] },
	AgentResult[]
>({
	name: "test.orchestrator",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) =>
			runtime.commit(async (tx) => {
				const group = await createGroup(tx, {
					groupId: task.input.groupId,
					ownerTaskId: task.id,
					agents: task.input.agents,
				});
				const drivers = await createDrivers(tx, { groupId: task.input.groupId, ownerTaskId: task.id, group });
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
	it("creates a group of three agents, and nothing else", async () => {
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
					groupId: "group-1",
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
		// The root's own agent: a child that asks for nothing inherits it.
		const root = await harness.root(context, {
			agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: "/work/inherited" },
		});
		const anchor = await root.commit(
			(tx) => tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true }),
			context,
		);
		const group = await harness.commit(
			(tx) =>
				createGroup(tx, {
					groupId: "group-1",
					ownerTaskId: anchor,
					agents: [
						{
							name: "reader",
							task: "Read the file.",
							agent: { model: { provider: "faux", modelId: "faux-2" }, cwd: "/work/read" },
						},
						{ name: "scout", task: "Scout the repository." },
					],
				}),
			context,
		);
		const reader = group.agents[0]!;
		const scout = group.agents[1]!;
		expect((await harness.snapshot(AgentDoc, reader.conversationId, context))?.model).toEqual({
			provider: "faux",
			modelId: "faux-2",
		});
		expect((await harness.snapshot(AgentDoc, reader.conversationId, context))?.cwd).toBe("/work/read");
		// The agent that asked for nothing inherits the owner's agent: its model and its cwd.
		const inherited = await harness.snapshot(AgentDoc, scout.conversationId, context);
		expect(inherited?.cwd).toBe("/work/inherited");
		expect(inherited?.model).toEqual({ provider: "faux", modelId: "faux-1" });
	});

	it("drives the group to its answers, all at once", async () => {
		const setup = chatSetup();
		// Both agents answer only once both have asked: the group runs at the same time.
		const arrived: string[] = [];
		let open = (): void => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const waiting = async () => {
			arrived.push("asked");
			if (arrived.length === 2) open();
			await gate;
			return fauxAssistantMessage([fauxText("An answer.")]);
		};
		setup.faux.setResponses([waiting, waiting]);
		setup.registry.install(defineExtension({ name: "orchestration", tasks: [Orchestrator, OrchestratedAgent] }));
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const orchestrator = await root.commit(
			(tx) =>
				tx.createTask(
					Orchestrator,
					{
						groupId: "group-drive",
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
		const settled = await harness.waitForTask(orchestrator, context);
		expect(settled.state.outcome.status, JSON.stringify(setup.reports.map(String))).toBe("completed");
		const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];
		expect(results.map((result) => result.name).sort()).toEqual(["reader", "scout"]);
		expect(results.every((result) => result.status === "answered")).toBe(true);
		// Both agents were asked before either answered: the group ran at once.
		expect(arrived).toHaveLength(2);
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
						groupId: "group-1",
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
						groupId: "group-1",
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
						{ groupId: "group-1", agents: [{ name: "reader", task: "What does the file say?" }] },
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

describe("the orchestration layer's results", () => {
	it("reports a faulted or orphaned driver as failed, with its reason", async () => {
		const host = {
			waitForTask: async (id: TaskId) =>
				({
					state: {
						status: "terminal",
						outcome:
							id === 1
								? { status: "faulted", error: { message: "the driver crashed" } }
								: { status: "orphaned" },
					},
				}) as never,
		};
		const results = await joinAgents(
			host,
			{
				drivers: [
					{ name: "reader", taskId: 1 as TaskId<string> },
					{ name: "scout", taskId: 2 as TaskId<string> },
				],
			},
			context,
		);
		expect(results.map((result) => result.status)).toEqual(["failed", "failed"]);
		expect(results[0]?.error).toContain("the driver crashed");
		expect(results[1]?.error).toBeTruthy();
	});

	it("keeps a driver's answer when the group's other driver is aborted", async () => {
		const setup = chatSetup();
		const storage = new MemoryStorage();
		// Both agents wait for the gate, so both are still working when one run is aborted.
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = async (_request: unknown, options?: { signal?: AbortSignal }) => {
			// The wait ends when the gate opens or the run is cancelled.
			await Promise.race([gate, aborted(options!.signal!)]);
			return fauxAssistantMessage([fauxText("An answer.")]);
		};
		setup.faux.setResponses([waiting, waiting]);
		setup.registry.install(defineExtension({ name: "orchestration", tasks: [Orchestrator, OrchestratedAgent] }));
		const { harness, root } = await openChat(storage, setup);
		const orchestrator = await root.commit(
			(tx) =>
				tx.createTask(
					Orchestrator,
					{
						groupId: "group-abort",
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
		// The drivers of the group, from the orchestrator's checkpoint.
		const driversOf = async (): Promise<{ name: string; taskId: TaskId }[]> => {
			for (let attempt = 0; attempt < 200; attempt++) {
				const record = await harness.getTask(orchestrator, context);
				const drivers = (record?.state as { checkpoint?: { drivers?: { name: string; taskId: TaskId }[] } })
					.checkpoint?.drivers;
				if (drivers !== undefined) return drivers;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			return [];
		};
		const drivers = await driversOf();
		expect(drivers).toHaveLength(2);
		// The group's conversations: the first agent's run is stopped, the second keeps working.
		const conversations = await storage.scanConversations({ ownerTaskId: orchestrator }, 10, undefined, context);
		expect(conversations.items).toHaveLength(2);
		const stopped = await harness.conversation(conversations.items[0]!.id, context);
		expect(stopped).toBeDefined();
		await stopped!.abort(context);
		release();
		const settled = await harness.waitForTask(orchestrator, context);
		expect(settled.state.outcome.status).toBe("completed");
		const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];
		const stoppedResult = results.find((result) => result.name === drivers[0]!.name);
		const otherResult = results.find((result) => result.name === drivers[1]!.name);
		expect(stoppedResult?.status).toBe("aborted");
		expect(otherResult?.status).toBe("answered");
	});

	it("asks a group the same question twice, and the answer comes once", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([fauxAssistantMessage([fauxText("The only answer.")])]);
		setup.registry.install(defineExtension({ name: "orchestration", tasks: [OrchestratedAgent] }));
		const { harness, root } = await openChat(new MemoryStorage(), setup);
		const anchor = await root.commit(
			(tx) => tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true }),
			context,
		);
		const group = await harness.commit(
			(tx) =>
				createGroup(tx, {
					groupId: "group-rerun",
					ownerTaskId: anchor,
					agents: [{ name: "reader", task: "What does the file say?" }],
				}),
			context,
		);
		harness.resume();
		// The group is driven twice, as a replay-safe caller would: the same group id, so the same request ids.
		for (const _attempt of [1, 2]) {
			await harness.commit(async (tx) => {
				await createDrivers(tx, { groupId: "group-rerun", ownerTaskId: anchor, group });
				return undefined;
			}, context);
		}
		const conversation = await harness.conversation(group.agents[0]!.conversationId, context);
		expect(conversation).toBeDefined();
		let answers = 0;
		for (let attempt = 0; attempt < 200; attempt++) {
			const entries = await conversation!.entries({}, 50, undefined, context);
			answers = entries.items.filter((entry) => entry.kind === "pi.assistant").length;
			if (answers > 0) break;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		// The second driver asked with the same request id: the answer was written once.
		expect(answers).toBe(1);
	});
});
