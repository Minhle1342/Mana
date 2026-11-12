// The orchestration layer's one-shot drive: a task per agent that runs it to its answer.
import type { Message } from "@earendil-works/pi-ai";
import { AssistantEntry } from "../entries.ts";
import { defineTask } from "../tasks.ts";
import type { ConversationId, TaskId, Tx } from "../types.ts";
import type { AgentGroup } from "./types.ts";

/** What a driver runs: the agent's name, its prompt, and the conversation it runs in. */
export type AgentDriverInput = {
	readonly name: string;
	readonly task: string;
	readonly conversationId: ConversationId;
};

/** One driver of a group: the agent it runs and the task that runs it. */
export type AgentDriver = {
	readonly name: string;
	readonly taskId: TaskId<string>;
};

/** What `createDrivers` needs: the group, and the task that owns the drivers. */
export type AgentDriverRequest = {
	readonly ownerTaskId: TaskId;
	readonly group: AgentGroup;
};

/** The text of an assistant message, the answer a driver reports. */
function textOf(message: Message | undefined): string {
	if (message === undefined) return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * Runs one agent of a group to its answer: it submits the agent's prompt to the group's conversation, waits for the
 * answer, and ends with that answer as its outcome. The prompt carries a request ID derived from the driver's task ID,
 * so a rerun after a crash gets the same submission back instead of a second one.
 */
export const OrchestratedAgent = defineTask<AgentDriverInput, { phase: "run" }, string>({
	name: "pi.orchestrated-agent",
	version: 1,
	initial: () => ({ phase: "run" }),
	phases: {
		run: async (task, runtime, ctx) => {
			const { name, task: prompt, conversationId } = task.input;
			const conversation = await runtime.conversation(conversationId, ctx);
			if (conversation === undefined) {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: { status: "failed", error: { message: `No conversation for agent ${name}.` } },
					}),
					ctx,
				);
				return;
			}
			const submission = await conversation.submit(
				{ type: "input", content: prompt, requestId: `agent:${task.id}` },
				ctx,
			);
			const settled = await submission.wait(ctx);
			if (settled.status !== "done" || settled.type !== "input") {
				await runtime.commit(
					() => ({
						status: "terminal",
						outcome: {
							status: "failed",
							error: { message: `Agent ${name} failed: ${settled.reason ?? "no answer"}.` },
						},
					}),
					ctx,
				);
				return;
			}
			await runtime.commit(async (tx) => {
				const answer = await tx.entry(AssistantEntry, settled.answer);
				return { status: "terminal", outcome: { status: "completed", result: textOf(answer?.model?.[0]) } };
			}, ctx);
		},
	},
	abort: async (_task, runtime, ctx) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/**
 * Creates one driver per agent of the group, in the caller's commit. Each driver runs its agent in the conversation the
 * group created; the drivers are owned by the caller, so the caller's finish waits for them.
 */
export async function createDrivers(tx: Tx, request: AgentDriverRequest): Promise<readonly AgentDriver[]> {
	const drivers: AgentDriver[] = [];
	for (const agent of request.group.agents) {
		const taskId = await tx.createTask(
			OrchestratedAgent,
			{ name: agent.name, task: agent.task, conversationId: agent.conversationId },
			{ ownership: { kind: "task", taskId: request.ownerTaskId } },
		);
		drivers.push({ name: agent.name, taskId });
	}
	return drivers;
}
