// The orchestration layer's join: what a group of drivers answered.
import type { Context } from "@earendil-works/chord/context";
import type { SettledTask } from "../harness/types.ts";
import type { TaskId } from "../types.ts";
import type { AgentDriver } from "./agent-task.ts";
import type { AgentResult } from "./types.ts";

/** What the join needs to wait for a group's drivers and read their outcomes. */
export interface AgentJoinHost {
	waitForTask<R>(id: TaskId<R>, context: Context): Promise<SettledTask<R>>;
}

/** What `joinAgents` needs: the group's drivers. */
export type AgentJoinRequest = {
	readonly drivers: readonly AgentDriver[];
};

/**
 * Waits for every driver of the group and reports one result per agent: its answer, or why it has none. One agent's
 * failure does not hide the others' answers.
 */
export async function joinAgents(
	host: AgentJoinHost,
	request: AgentJoinRequest,
	context: Context,
): Promise<AgentResult[]> {
	const results: AgentResult[] = [];
	for (const driver of request.drivers) {
		const settled = await host.waitForTask(driver.taskId, context);
		const outcome = settled.state.outcome;
		if (outcome.status === "completed") {
			results.push({ name: driver.name, status: "answered", answer: outcome.result });
		} else if (outcome.status === "aborted") {
			results.push({
				name: driver.name,
				status: "aborted",
				...(outcome.reason === undefined ? {} : { error: outcome.reason }),
			});
		} else if (outcome.status === "failed") {
			results.push({ name: driver.name, status: "failed", error: outcome.error.message });
		} else if (outcome.status === "orphaned") {
			results.push({ name: driver.name, status: "failed", error: `the agent cannot run: ${outcome.reason}` });
		} else {
			results.push({ name: driver.name, status: "failed", error: outcome.error.message });
		}
	}
	return results;
}
