// The chat's group status: the subagents working in the session, the line that says so, and the selector that opens
// one of them.
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@p2/app/v1/tui";
import type { Child } from "../subagents/contract.ts";

/**
 * The session's subagents: the group the status line shows. No one-shot agents, no archived ones, and none whose
 * state the worker did not report (an older worker, a restart): its state is unknown, not "idle".
 */
export function groupOf(children: readonly Child[] | undefined): Child[] {
	return (children ?? []).filter(
		(child) => child.kind === undefined && child.archived !== true && child.state !== undefined,
	);
}

/** What the line says: how many work, or how many answered. */
export function subagentStatus(children: readonly Child[] | undefined): { text: string; done: boolean } | undefined {
	const group = groupOf(children);
	if (group.length === 0) return undefined;
	const working = group.filter((child) => child.state === "working").length;
	if (working > 0) return { text: `${working} subagent(s) working`, done: false };
	const answered = group.filter((child) => child.state === "answered").length;
	return { text: `${answered}/${group.length} subagent(s) done`, done: answered === group.length };
}

/** The rows the selector lists: the working subagents first. */
export function subagentRows(children: readonly Child[] | undefined): { key: string; label: string; detail: string }[] {
	return groupOf(children)
		.sort((left, right) => Number(right.state === "working") - Number(left.state === "working"))
		.map((child) => ({ key: String(child.conversationId), label: child.name, detail: child.state ?? "idle" }));
}

/** The line under the composer: the group's status, green when every agent answered. */
export function subagentStatusLines(theme: Theme, children: readonly Child[] | undefined): string[] {
	const status = subagentStatus(children);
	if (status === undefined) return [];
	const text = status.done ? theme.fg("success", status.text) : theme.fg("muted", status.text);
	return [truncateToWidth(` ${text}`, 200)];
}
