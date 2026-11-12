// The chat's group status: what the line under the composer says, and what the selector lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { subagentRows, subagentStatus, subagentStatusLines } from "../../plugins/chat/tui-subagents.ts";
import type { Child } from "../../plugins/subagents/contract.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";

const child = (over: Partial<Child> & { name: string; conversationId: number }): Child => ({
	model: "faux/faux-1",
	thinkingLevel: "off",
	tools: [],
	lastEntryId: 0,
	...over,
});

const theme = new ThemeRef(createTheme(BUILTIN_THEMES.dark!, "truecolor")).current;

test("the status line counts the working and the answered subagents", () => {
	const working = [
		child({ name: "reader", conversationId: 2, state: "working" }),
		child({ name: "scout", conversationId: 3, state: "working" }),
	];
	assert.deepEqual(subagentStatus(working), { text: "2 subagent(s) working", done: false });
	const answered = [
		child({ name: "reader", conversationId: 2, state: "answered" }),
		child({ name: "scout", conversationId: 3, state: "idle" }),
	];
	assert.deepEqual(subagentStatus(answered), { text: "1/2 subagent(s) done", done: false });
	const all = [...answered, child({ name: "writer", conversationId: 4, state: "answered" })];
	assert.deepEqual(subagentStatus(all), { text: "2/3 subagent(s) done", done: false });
	// Every agent answered: the done state.
	const done = [child({ name: "reader", conversationId: 2, state: "answered" })];
	assert.deepEqual(subagentStatus(done), { text: "1/1 subagent(s) done", done: true });
	// No group: no line.
	assert.equal(subagentStatus([]), undefined);
	assert.equal(subagentStatus(undefined), undefined);
	// An archived subagent and a one-shot agent are not the group.
	assert.equal(subagentStatus([child({ name: "old", conversationId: 5, archived: true })]), undefined);
	assert.equal(subagentStatus([child({ name: "script", conversationId: 6, kind: "agent" })]), undefined);
});

test("the line renders the group's status, green when every agent answered", () => {
	const working = subagentStatusLines(theme, [child({ name: "reader", conversationId: 2, state: "working" })]);
	assert.match(stripTerminalSequences(working.join("\n")), /1 subagent\(s\) working/);
	const done = subagentStatusLines(theme, [child({ name: "reader", conversationId: 2, state: "answered" })]);
	assert.match(stripTerminalSequences(done.join("\n")), /1\/1 subagent\(s\) done/);
	// No group: the row is empty.
	assert.deepEqual(subagentStatusLines(theme, []), []);
});

test("the selector lists the working subagents first", () => {
	const rows = subagentRows([
		child({ name: "reader", conversationId: 2, state: "answered" }),
		child({ name: "scout", conversationId: 3, state: "working" }),
		child({ name: "old", conversationId: 4, state: "idle", archived: true }),
	]);
	assert.deepEqual(rows, [
		{ key: "3", label: "scout", detail: "working" },
		{ key: "2", label: "reader", detail: "answered" },
	]);
});
