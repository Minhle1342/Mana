import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxResponseStep, type Models, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentGroup } from "../src/core/durable/group.ts";
import { openDurableAgentHarness } from "../src/core/durable/harness.ts";
import { openDurableStore } from "../src/core/durable/store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const context = BACKGROUND_CONTEXT;

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "pi-durable-agents-"));
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

/** A faux provider whose scripted answers are routed by the prompt, and the session the store is named after. */
function setup(responses: FauxResponseStep[]): {
	readonly models: Models;
	readonly sessionManager: SessionManager;
} {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	return { models, sessionManager: SessionManager.create(directory, join(directory, "sessions")) };
}

async function open(models: Models, sessionManager: SessionManager) {
	return openDurableAgentHarness(await openDurableStore(sessionManager, join(directory, "agent")), {
		models,
		cwd: directory,
		model: { provider: "faux", modelId: "faux-1" },
	});
}

/** The text of the last message that is not a system prompt. */
function promptOf({ messages }: TranscriptContext): string {
	const last = messages.findLast((message) => message.role !== "system");
	if (last === undefined) return "";
	if (typeof last.content === "string") return last.content;
	return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

/** Answers every prompt with the prompt itself, so each agent's answer names the agent that asked. */
function echo(count: number): FauxResponseStep[] {
	const step: FauxResponseStep = (request) => fauxAssistantMessage([fauxText(`answer to ${promptOf(request)}`)]);
	return Array.from({ length: count }, () => step);
}

describe("the durable agents layer", () => {
	it("runs two agents and returns both answers", async () => {
		const { models, sessionManager } = setup(echo(4));
		const { harness, root } = await open(models, sessionManager);
		try {
			const run = await runAgentGroup({
				harness,
				root,
				groupId: "two-agents",
				agents: [
					{ name: "reader", task: "read the file" },
					{ name: "writer", task: "write the file" },
				],
			});
			expect(run.results).toEqual([
				{ name: "reader", status: "answered", answer: "answer to read the file" },
				{ name: "writer", status: "answered", answer: "answer to write the file" },
			]);
			expect(run.group.agents).toHaveLength(2);
		} finally {
			await harness.close(context);
		}
	});

	it("reports one agent's failure without hiding the other's answer", async () => {
		const step: FauxResponseStep = (request) => {
			if (promptOf(request).includes("broken")) throw new Error("provider exploded");
			return fauxAssistantMessage([fauxText("fine")]);
		};
		const { models, sessionManager } = setup([step, step]);
		const { harness, root } = await open(models, sessionManager);
		try {
			const run = await runAgentGroup({
				harness,
				root,
				groupId: "one-fails",
				agents: [
					{ name: "good", task: "work" },
					{ name: "bad", task: "broken work" },
				],
			});
			expect(run.results[0]).toEqual({ name: "good", status: "answered", answer: "fine" });
			expect(run.results[1].name).toBe("bad");
			expect(run.results[1].status).toBe("failed");
			expect(run.results[1].error).toBeTruthy();
		} finally {
			await harness.close(context);
		}
	});

	it("aborts the agents that are still running", async () => {
		const stuck: FauxResponseStep = (_request, options) =>
			new Promise((_resolve, reject) => {
				const signal = options?.signal;
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		const { models, sessionManager } = setup([fauxAssistantMessage([fauxText("quick answer")]), stuck]);
		const { harness, root } = await open(models, sessionManager);
		const controller = new AbortController();
		try {
			const run = await runAgentGroup({
				harness,
				root,
				groupId: "aborted",
				agents: [
					{ name: "quick", task: "quick work" },
					{ name: "slow", task: "slow work" },
				],
				signal: controller.signal,
				onProgress: (result) => {
					if (result.name === "quick") controller.abort();
				},
			});
			expect(run.results[0]).toMatchObject({ name: "quick", status: "answered" });
			expect(run.results[1]).toMatchObject({ name: "slow", status: "aborted" });
		} finally {
			await harness.close(context);
		}
	});

	it("keeps the agents' transcripts after the store is reopened", async () => {
		const { models, sessionManager } = setup(echo(4));
		const first = await open(models, sessionManager);
		const run = await runAgentGroup({
			harness: first.harness,
			root: first.root,
			groupId: "reopened",
			agents: [{ name: "reader", task: "remember this" }],
		});
		await first.harness.close(context);

		const second = await open(models, sessionManager);
		try {
			const conversation = await second.harness.conversation(run.group.agents[0].conversationId, context);
			expect(conversation).toBeDefined();
			const page = await conversation!.entries({}, 100, undefined, context);
			const texts = page.items.flatMap((entry) =>
				(entry.model ?? []).flatMap((message) =>
					typeof message.content === "string"
						? [message.content]
						: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
				),
			);
			expect(texts).toContain("answer to remember this");
		} finally {
			await second.harness.close(context);
		}
	});
});
