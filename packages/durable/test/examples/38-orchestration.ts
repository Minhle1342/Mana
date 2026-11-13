// A group of agents: three conversations created in one commit, driven in parallel, and joined into one result. The
// group's answers come back per agent, so one agent's failure does not hide the others'.
// Run from packages/durable:
//   node --conditions=source --experimental-strip-types test/examples/38-orchestration.ts

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentDriver,
	type AgentRequest,
	type AgentResult,
	createDrivers,
	createGroup,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	joinAgents,
	MemoryStorage,
	OrchestratedAgent,
} from "../../src/index.ts";

const context = BACKGROUND_CONTEXT;

// ─── Product code: the orchestrator ─────────────────────────────────────────

/** Creates a group, drives it, and joins the answers. */
const Orchestrator = defineTask<
	{ agents: AgentRequest[]; groupId: string },
	{ phase: "run" } | { phase: "join"; drivers: readonly AgentDriver[] },
	AgentResult[]
>({
	name: "example.orchestrator",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		// One commit: the group's conversations, and one driver per agent.
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
		// The drivers run at once; the join waits for all of them.
		join: async (task, runtime, ctx) => {
			const results = await joinAgents(runtime, { drivers: task.state.checkpoint.drivers }, ctx);
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: results } }), ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

// ─── Host setup ─────────────────────────────────────────────────────────────

// Two agents answer; the third's model fails, and the others' answers still arrive.
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses([
	fauxAssistantMessage([fauxText("The file says: hello.")]),
	fauxAssistantMessage([fauxText("There are three files.")]),
	fauxAssistantMessage([fauxText("The model failed.")], { stopReason: "error", errorMessage: "boom" }),
]);

const registry = createRegistry();
registry.install(defineExtension({ name: "example.orchestration", tasks: [Orchestrator, OrchestratedAgent] }));

const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
harness.resume();

const orchestrator = await root.commit(
	(tx) =>
		tx.createTask(
			Orchestrator,
			{
				groupId: "example-group",
				agents: [
					{ name: "reader", task: "What does the file say?" },
					{ name: "counter", task: "How many files are there?" },
					{ name: "scout", task: "What kind of repository is this?" },
				],
			},
			{ ownership: { kind: "conversation" } },
		),
	context,
);

const settled = await harness.waitForTask(orchestrator, context);
const results = settled.state.outcome.status === "completed" ? settled.state.outcome.result : [];
console.log("The group answered:");
for (const result of results) {
	console.log(`  ${result.name}: ${result.status}${result.answer === undefined ? "" : ` — ${result.answer}`}`);
}

await harness.close(context);
