// The `agents` tool: run several subagents at once as durable conversations and return every answer in one result.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentResult } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import type { SessionManager } from "../session-manager.ts";
import { runAgentGroup } from "./group.ts";
import { openDurableAgentHarness } from "./harness.ts";
import { openDurableStore } from "./store.ts";

const agentsSchema = Type.Object({
	agents: Type.Array(
		Type.Object({
			name: Type.String({ description: "Short name for this agent, unique within the call" }),
			task: Type.String({ description: "What this agent should do, start to finish" }),
		}),
		{ description: "The agents to run at the same time, one conversation each" },
	),
});

export type DurableAgentsToolDeps = {
	/** pi's model runtime, which also serves durable's generation. */
	readonly models: Models;
	readonly sessionManager: SessionManager;
	readonly agentDir: string;
	readonly cwd: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: ModelThinkingLevel;
};

/** One line per agent for the model and the tool UI. */
function describe(result: AgentResult): string {
	if (result.status === "answered") return `${result.name}: answered - ${result.answer ?? ""}`;
	return `${result.name}: ${result.status} - ${result.error ?? "no answer"}`;
}

/**
 * The `agents` tool. It is inactive by default, so an existing pi session behaves the same until the tool is enabled
 * with `--tools agents` or the `defaultTools` setting. Each call opens the session's durable store, runs the group and
 * closes it; a call that runs no agent leaves no file open.
 */
export function createDurableAgentsTool(deps: DurableAgentsToolDeps): ToolDefinition {
	return defineTool({
		name: "agents",
		label: "Agents",
		description:
			"Run several agents at once, each with its own conversation and its own read, write, edit and shell tools. " +
			"Returns one line per agent: its answer, or why it has none. Use it for independent tasks that can run in parallel.",
		parameters: agentsSchema,
		defaultActive: false,
		executionMode: "sequential",
		execute: async (toolCallId, params, signal, onUpdate) => {
			const storage = await openDurableStore(deps.sessionManager, deps.agentDir);
			const { harness, root } = await openDurableAgentHarness(storage, {
				models: deps.models,
				cwd: deps.cwd,
				model: deps.model,
				thinkingLevel: deps.thinkingLevel,
			});
			const results: AgentResult[] = [];
			try {
				await runAgentGroup({
					harness,
					root,
					// The call id is committed in the transcript, so a replayed call keeps its group; a new call gets a new one.
					groupId: toolCallId,
					agents: params.agents,
					signal,
					onProgress: (result) => {
						results.push(result);
						onUpdate?.({
							content: [{ type: "text", text: results.map(describe).join("\n") }],
							details: { results },
						});
					},
				});
			} finally {
				await harness.close(BACKGROUND_CONTEXT);
			}
			return { content: [{ type: "text", text: results.map(describe).join("\n") }], details: { results } };
		},
	});
}
