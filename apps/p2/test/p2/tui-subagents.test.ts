// The chat's group status: what the line under the composer says, and what the selector lists.
import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { BACKGROUND_CONTEXT } from "@p2/app/v1";
import { VirtualTerminal } from "../../../../packages/tui/test/virtual-terminal.ts";
import { subagentRows, subagentStatus, subagentStatusLines } from "../../plugins/chat/tui-subagents.ts";
import { Devices } from "../../plugins/devices/contract.ts";
import { Sessions } from "../../plugins/sessions/contract.ts";
import type { Child } from "../../plugins/subagents/contract.ts";
import { startTuiClient } from "../../src/hosts/tui-client.ts";
import { claimOwner } from "../../src/hosts/tui-config.ts";
import { ThemeRef } from "../../src/tui/theme/ref.ts";
import { BUILTIN_THEMES, createTheme } from "../../src/tui/theme/theme.ts";
import { holdIn, poll, startFixture } from "./helpers.ts";

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

test("the chat shows the session's subagent status and opens one of them", async (t) => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const url = new URL(`http://127.0.0.1:${fixture.server.port}`);
	const browser = fixture.browser();
	const token = (await browser.hold(Devices, {}, BACKGROUND_CONTEXT).token(BACKGROUND_CONTEXT)).token;
	const sessions = await holdIn(browser, Sessions, {}, "owner");
	await sessions.create({ cwd: fixture.workspace, env: null }, BACKGROUND_CONTEXT);
	const terminal = new VirtualTerminal(100, 40);
	const failures: string[] = [];
	const client = await startTuiClient({
		terminal,
		url,
		credentials: await claimOwner(url, token, {}),
		pollMs: 1000,
		onFailure: (message) => failures.push(message),
	});
	t.after(() => client.close());
	const screen = async () => (await terminal.flushAndGetViewport()).join("\n");
	// The session list, then the chat.
	await poll(async () => (await screen()).includes("New session"), 20000, "session list");
	terminal.sendInput("\x1b[B");
	terminal.sendInput("\r");
	await poll(async () => (await screen()).includes("(faux) faux-1"), 10000, "chat screen");
	// The editor takes focus; the fake provider calls the subagent tool, which spawns a child that works.
	await poll(
		async () => {
			const drafts = ((await client.snapshot()) as { drafts: [string, string][] }).drafts;
			if (drafts.some(([, text]) => text === "subagent")) return true;
			terminal.sendInput("subagent");
			return false;
		},
		10000,
		"editor",
	);
	terminal.sendInput("\r");
	// The status line under the composer: the group works, then it is done.
	await poll(async () => /subagent\(s\) (working|done)/.test(await screen()), 20000, "the status line");
	await poll(async () => /1\/1 subagent\(s\) done/.test(await screen()), 30000, "the done state");
	// The selector: "/agents" lists the group.
	terminal.sendInput("/agents");
	terminal.sendInput("\r");
	await poll(async () => /helper/.test(await screen()), 10000, "the selector");
	// Picking the subagent opens its own conversation.
	terminal.sendInput("\r");
	await poll(async () => /Echo: hello helper/.test(await screen()), 20000, "the subagent's conversation");
	assert.deepEqual(failures, []);
});
