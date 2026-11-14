// The durable Harness a pi session drives for subagents: pi's models, durable's coding tools, and one root profile.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	Harness,
	type ModelRef,
	type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools, createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { AgentGroupTasks } from "./group.ts";

export type DurableHarnessOptions = {
	/** pi's model runtime: it implements durable's `Models`, so no second provider stack is built. */
	readonly models: Models;
	readonly cwd: string;
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
};

/**
 * Opens the Harness over `storage` and its root conversation. The root carries the agent every group member inherits:
 * cwd, model, thinking level. Subagents run durable's own `read`/`write`/`edit`/`bash` (and `powershell` on Windows),
 * not pi's tools.
 */
export async function openDurableAgentHarness(
	storage: Storage,
	options: DurableHarnessOptions,
): Promise<{ readonly harness: Harness; readonly root: Conversation }> {
	const registry = createRegistry();
	registry.install(createCodingTools());
	registry.install(AgentGroupTasks);
	if (process.platform === "win32") {
		registry.install(defineExtension({ name: "powershell", tools: [createPowerShellTool()] }));
	}
	const harness = await Harness.open(
		storage,
		{
			models: options.models,
			registry,
			env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
		},
		BACKGROUND_CONTEXT,
	);
	const root = await harness.root(BACKGROUND_CONTEXT, {
		agent: { cwd: options.cwd, model: options.model, thinkingLevel: options.thinkingLevel },
	});
	harness.resume();
	return { harness, root };
}
