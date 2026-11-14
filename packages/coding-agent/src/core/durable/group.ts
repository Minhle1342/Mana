// One run of a group of subagents: a background anchor owns their conversations, drivers run them, a join collects
// every answer.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type AgentGroup,
	type AgentResult,
	type Conversation,
	createDrivers,
	createGroup,
	defineExtension,
	defineTask,
	type Harness,
	joinAgents,
	OrchestratedAgent,
} from "@earendil-works/pi-durable";

// The group's conversations are owned by this task. It finishes at once, so the group outlives the call that made it,
// and the parent conversation's idle waits and Esc stop at it.
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "pi.coding-agent.anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, taskContext) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), taskContext),
	},
	abort: (_anchor, runtime, taskContext) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), taskContext),
});

/** The tasks a group runs. The Harness must install them, or its drivers never leave the queue. */
export const AgentGroupTasks = defineExtension({ name: "pi.coding-agent.agents", tasks: [Anchor, OrchestratedAgent] });

export type AgentGroupRun = {
	/** The group's conversations, one per agent, oldest first. */
	readonly group: AgentGroup;
	readonly results: AgentResult[];
};

export type RunAgentGroupOptions = {
	readonly harness: Harness;
	readonly root: Conversation;
	/** The group's name: a rerun of the same call reuses the drivers' request ids. */
	readonly groupId: string;
	readonly agents: readonly { readonly name: string; readonly task: string }[];
	readonly signal?: AbortSignal;
	/** Called once per agent, in the order the agents settle. */
	readonly onProgress?: (result: AgentResult) => void;
};

/**
 * Creates the group and its drivers in one commit, then waits for every driver and returns one result per agent. One
 * agent's failure does not hide another's answer. An abort stops every driver, and their settled outcomes are returned.
 */
export async function runAgentGroup(options: RunAgentGroupOptions): Promise<AgentGroupRun> {
	const { harness, root, groupId, agents, signal, onProgress } = options;
	const { group, drivers } = await root.commit(async (tx) => {
		const anchor = await tx.createTask(Anchor, null, { ownership: { kind: "conversation" }, background: true });
		const group = await createGroup(tx, { groupId, ownerTaskId: anchor, agents });
		const drivers = await createDrivers(tx, { groupId, ownerTaskId: anchor, group });
		return { group, drivers };
	}, BACKGROUND_CONTEXT);
	const results: AgentResult[] = [];
	// A cancel marks every driver at once; the wait below then reads their aborted outcomes. A driver that already
	// finished has nothing left to abort, and a failed Session is reported by the Harness.
	const abort = () => {
		for (const driver of drivers) void harness.abortTask(driver.taskId, BACKGROUND_CONTEXT).catch(() => {});
	};
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted === true) abort();
	try {
		for (const driver of drivers) {
			const [result] = await joinAgents(harness, { drivers: [driver] }, BACKGROUND_CONTEXT);
			results.push(result);
			onProgress?.(result);
		}
	} finally {
		signal?.removeEventListener("abort", abort);
	}
	return { group, results };
}
