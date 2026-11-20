// Pins the turn-checkpoint boundary of a run: a tool call waits for the turn's snapshot, and a run
// that fails before it starts never creates one.

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckpointManager } from "../../src/core/checkpoint-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession checkpoint ordering", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("holds tool calls until the turn's checkpoint settles", async () => {
		const order: string[] = [];
		let settleCheckpoint = () => {};
		const checkpoint = new Promise<string | null>((resolve) => {
			settleCheckpoint = () => {
				order.push("checkpoint");
				resolve("ref");
			};
		});
		const harness = await createHarness({
			checkpointManager: { createCheckpoint: vi.fn(() => checkpoint) } as unknown as CheckpointManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "record",
						label: "record",
						description: "Records that it ran.",
						parameters: Type.Object({}),
						execute: async () => {
							order.push("tool");
							return { content: [{ type: "text", text: "recorded" }], details: {} };
						},
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("record", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const run = harness.session.prompt("go");
		// Let the request answer and the tool call arrive before the snapshot settles.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(order).toEqual([]);

		settleCheckpoint();
		await run;

		expect(order).toEqual(["checkpoint", "tool"]);
	});

	it("starts the turn's checkpoint after before_agent_start ran", async () => {
		const order: string[] = [];
		const harness = await createHarness({
			checkpointManager: {
				createCheckpoint: vi.fn(async () => {
					order.push("checkpoint");
					return null;
				}),
			} as unknown as CheckpointManager,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						order.push("hook");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");

		// The snapshot covers the tree the first request starts from, so a hook that writes files is included.
		expect(order).toEqual(["hook", "checkpoint"]);
	});
});
