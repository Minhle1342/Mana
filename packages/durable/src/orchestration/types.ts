// The orchestration layer's shapes: an agent request, the group it belongs to, and the result of running it.
import type { AgentChange } from "../harness/types.ts";
import type { ConversationId, TaskId } from "../types.ts";

/** One agent of a group: its name, the task it runs, and the agent state it runs with. */
export type AgentRequest = {
	readonly name: string;
	readonly task: string;
	/** The agent state the conversation gets: model, thinking level, cwd, tools, extensions, instructions. */
	readonly agent?: AgentChange;
};

/** What `createGroup` needs: the group's id, its agents, and the task that owns their conversations. */
export type AgentGroupRequest = {
	/** The group's id: the caller's name for it, and the drivers' request ids come from it. */
	readonly groupId: string;
	/** The task that owns the group's conversations. */
	readonly ownerTaskId: TaskId;
	readonly agents: readonly AgentRequest[];
};

/** One agent of a group, after the group was created. */
export type AgentSlot = {
	readonly name: string;
	/** The task the agent runs. */
	readonly task: string;
	readonly conversationId: ConversationId;
};

/** A group of agents: one conversation each. */
export type AgentGroup = {
	readonly agents: readonly AgentSlot[];
};

/** How an agent's run ended. */
export type AgentStatus = "answered" | "failed" | "aborted";

/** One agent's result: its answer, or why it has none. */
export type AgentResult = {
	readonly name: string;
	readonly status: AgentStatus;
	readonly answer?: string;
	readonly error?: string;
};
