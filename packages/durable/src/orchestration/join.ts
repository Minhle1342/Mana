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

function formatError(error: unknown): string {
	if (error === undefined || error === null) return "unknown error";
	if (typeof error === "string") return error;
	if (typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
		return (error as { message: string }).message;
	}
	return String(error);
}

/**
 * Waits for every driver of the group and reports one result per agent: its answer, or why it has none. One agent's
 * failure does not hide the others' answers.
 */
export async function joinAgents(
	host: AgentJoinHost,
	request: AgentJoinRequest,
	context: Context,
): Promise<AgentResult[]> {
	return Promise.all(
		request.drivers.map(async (driver): Promise<AgentResult> => {
			const settled = await host.waitForTask(driver.taskId, context);
			const outcome = settled.state.outcome;
			if (outcome.status === "completed") {
				return { name: driver.name, status: "answered", answer: outcome.result };
			}
			if (outcome.status === "aborted") {
				return {
					name: driver.name,
					status: "aborted",
					...(outcome.reason === undefined ? {} : { error: outcome.reason }),
				};
			}
			if (outcome.status === "failed" || outcome.status === "faulted") {
				return { name: driver.name, status: "failed", error: formatError(outcome.error) };
			}
			if (outcome.status === "orphaned") {
				return { name: driver.name, status: "failed", error: `the agent cannot run: ${outcome.reason}` };
			}
			return { name: driver.name, status: "failed", error: "unknown outcome" };
		}),
	);
}
