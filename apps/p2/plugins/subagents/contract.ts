import { arr, bool, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import {
	evolve,
	type Location,
	LocationSchema,
	literal,
	local,
	method,
	param,
	record,
	remote,
	serverHost,
	sessionHost,
} from "@p2/app/v1";

/** A child's fields in `Child` v2. */
const CHILD_FIELDS = {
	/** A subagent's name; a one-shot agent's label. */
	name: str(),
	/** `agent`: a code mode script's one-shot agent, read-only and listed on the script's tool card, not the sidebar. */
	kind: opt(literal("agent")),
	/** A one-shot agent's nested call ID (`<script call ID>/c<n>`), as the script's tool card lists it. */
	callId: opt(str()),
	/** An archived subagent: hidden in the sidebar's archived row; still usable. */
	archived: opt(bool()),
	conversationId: num(),
	model: str(),
	thinkingLevel: str(),
	tools: arr(str()),
	/** A subagent's own location (environment and cwd, e.g. a git worktree); absent: it follows the session. */
	location: opt(LocationSchema),
	lastEntryId: num(),
};

/** What a subagent is doing: working, answered (it produced an answer), or idle. */
export const ChildStateSchema = union([literal("working"), literal("answered"), literal("idle")]);

/** A child as version 2 stored it: without its state. */
const ChildSchemaV2 = obj(CHILD_FIELDS);

export const ChildSchema = obj({
	...CHILD_FIELDS,
	/** What it is doing now; absent: the worker did not report one (an older worker). */
	state: opt(ChildStateSchema),
});
export type Child = Static<typeof ChildSchema>;

const ChildrenSchemaV2 = record(arr(ChildSchemaV2));
const ChildrenSchema = record(arr(ChildSchema));

/** Where a conversation works: a child's own location, else the session's (the main conversation's). */
export const conversationLocation = (
	session: { readonly cwd: string; readonly env?: string | null } | undefined,
	child: Child | undefined,
): Location | undefined => child?.location ?? (session ? { cwd: session.cwd, env: session.env ?? null } : undefined);

/**
 * The remote environments a session's conversations work on: the session's, then its subagents' own (archived ones
 * included: still usable). A read/write guest can reach all of them.
 */
export const remoteEnvironments = (
	session: { readonly env?: string | null } | undefined,
	children: readonly Child[] | undefined,
): string[] => [
	...new Set(
		[session?.env, ...(children ?? []).map((child) => child.location?.env)].filter(
			(env): env is string => typeof env === "string" && env !== "",
		),
	),
];

/**
 * The own locations the server recorded for a session's subagents, by conversation ID: a worker init value
 * (`subagentLocations`), so a worker places a version 1 own cwd on the environment it was spawned on.
 */
export const SubagentLocationsSchema = record(LocationSchema);

/**
 * Persistent sidebar metadata; transcripts remain in the worker's Durable storage. 3: a child's state (what it is
 * doing now); the provider still serves 2 (its `accepts`).
 */
export const ChildStore = evolve(
	local("p2.child-store", {
		// 2: a child's own location instead of its own cwd.
		version: 2,
		params: {},
		members: {
			children: ChildrenSchemaV2,
			report: method(obj({ session: str(), generation: num(), children: arr(ChildSchemaV2) })),
		},
	}),
	(e) =>
		e
			.state("children", ChildrenSchema)
			.args("report", obj({ session: str(), generation: num(), children: arr(ChildSchema) })),
);

/**
 * Workers report their own children; readers never start workers just to fill the sidebar. 3: a child's state; the
 * provider still serves 2 (its `accepts`).
 */
export const Subagents = evolve(
	remote("p2.subagents", {
		// 2: a child's own location instead of its own cwd.
		version: 2,
		params: {},
		hostAddress: serverHost,
		variants: {
			reader: { state: { children: ChildrenSchemaV2 } },
			reporter: { methods: { report: method(obj({ children: arr(ChildSchemaV2) })) } },
		},
	}),
	(e) => e.state("reader", "children", ChildrenSchema).args("report", obj({ children: arr(ChildSchema) })),
);

/** Changing a session's subagents from the browser (worker): the owner and read/write guests. */
export const SubagentControl = remote("p2.subagent-control", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		participant: {
			methods: {
				/**
				 * Archives a subagent (stopping its work first) or restores it. One-shot agents are read-only: they belong to
				 * the script waiting for their answer.
				 */
				archive: method(obj({ conversation: num(), archived: bool() })),
			},
		},
	},
});

export { ChildrenSchema };

export {
	AGENT_MESSAGE_ENTRY,
	type AgentMessage,
	AgentMessageSchema,
	SUBAGENT_TASK_ENTRY,
} from "@p2/app/v1";
