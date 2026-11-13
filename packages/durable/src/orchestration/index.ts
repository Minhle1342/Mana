// The orchestration layer's public surface.
export {
	type AgentDriver,
	type AgentDriverInput,
	type AgentDriverRequest,
	createDrivers,
	OrchestratedAgent,
} from "./agent-task.ts";
export { createGroup } from "./group.ts";
export { type AgentJoinHost, type AgentJoinRequest, joinAgents } from "./join.ts";
export type {
	AgentGroup,
	AgentGroupRequest,
	AgentRequest,
	AgentResult,
	AgentSlot,
	AgentStatus,
} from "./types.ts";
