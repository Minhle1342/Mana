// The orchestration layer's group: one conversation per agent, created in the caller's commit.
import { configure } from "../harness/agent.ts";
import type { Tx } from "../types.ts";
import type { AgentGroup, AgentGroupRequest, AgentSlot } from "./types.ts";

/**
 * Creates the group's conversations in the caller's commit, one per agent. Every conversation is owned by
 * `ownerTaskId`, and an agent that asked for a profile gets it; a field the profile leaves out keeps the value the
 * conversation inherited. Returns the group; the caller drives the agents as it likes.
 */
export async function createGroup(tx: Tx, request: AgentGroupRequest): Promise<AgentGroup> {
	const agents: AgentSlot[] = [];
	for (const agent of request.agents) {
		const record = await tx.createConversation({ ownership: { kind: "task", taskId: request.ownerTaskId } });
		if (agent.agent !== undefined) await configure(tx, record.id, agent.agent);
		agents.push({ name: agent.name, task: agent.task, conversationId: record.id });
	}
	return { agents };
}
