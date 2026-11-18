import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	type BashBackgroundOutcome,
	type BashOperations,
	createBashBackgroundController,
	createBashToolDefinition,
} from "../src/core/tools/bash.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/**
 * The WriteStream opens the temp file before it flushes queued writes, so a file can exist
 * while still being empty. Poll the content, not the file.
 */
async function waitForContent(path: string, expected: string): Promise<string> {
	for (let waited = 0; waited < 2000; waited += 10) {
		const content = await readFile(path, "utf-8").catch(() => "");
		if (content.includes(expected)) return content;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return await readFile(path, "utf-8").catch(() => "");
}

/** Fake backend that honors detach: returns a detached result and lets the test finish the child later. */
function createDetachableOperations() {
	let emit: ((data: Buffer) => void) | undefined;
	let finish: (() => void) | undefined;
	const operations: BashOperations = {
		exec: async (_command, _cwd, { onData, detach }) => {
			emit = onData;
			onData(Buffer.from("before\n"));
			const completion = new Promise<{ exitCode: number | null }>((resolve) => {
				finish = () => resolve({ exitCode: 0 });
			});
			// This fake backend requires the detach option, like the local backend.
			const detached = await Promise.race([detach!.then(() => true), completion.then(() => false)]);
			if (!detached) {
				return await completion;
			}
			return { exitCode: null, detached: true, completion };
		},
	};
	return {
		operations,
		/** Output written after the tool already returned, as a real detached child would. */
		emitAfterDetach: (data: Buffer) => emit?.(data),
		finishChild: () => finish?.(),
	};
}

/** Fake backend that ignores backgrounding entirely, as custom remote operations would. */
function createPlainOperations(options: { block: () => void }): BashOperations {
	return {
		exec: async (_command, _cwd, { onData }) => {
			onData(Buffer.from("plain\n"));
			options.block();
			return { exitCode: 0 };
		},
	};
}

describe("bash tool backgrounding", () => {
	it("returns immediately with a real output path when detached", async () => {
		const controller = createBashBackgroundController();
		const child = createDetachableOperations();
		const tool = createBashToolDefinition(process.cwd(), {
			operations: child.operations,
			exposeSessionEnvironment: false,
			background: controller,
		});

		const execute = tool.execute("bg-1", { command: "x" }, undefined, undefined, {} as never);
		const request = controller.request();
		const result = await execute;

		const text = textOf(result);
		expect(text).toContain("detached");
		const path = text.match(/written to (\S+?\.log)/)?.[1];
		expect(path).toBeTruthy();
		const contents = await waitForContent(path!, "before\n");
		expect(contents).toBe("before\n");
		const outcome = await request;
		expect(outcome).toEqual({ status: "detached", outputPath: path });
		// The slot was released: a second request finds no running command.
		expect(await controller.request()).toEqual({ status: "no-command" });
	});

	it("keeps writing post-detach output to the file until the child completes", async () => {
		const controller = createBashBackgroundController();
		const child = createDetachableOperations();
		const tool = createBashToolDefinition(process.cwd(), {
			operations: child.operations,
			exposeSessionEnvironment: false,
			background: controller,
		});

		const execute = tool.execute("bg-2", { command: "x" }, undefined, undefined, {} as never);
		const request = controller.request();
		const result = await execute;
		const path = textOf(result).match(/written to (\S+?\.log)/)?.[1];
		expect(path).toBeTruthy();

		child.emitAfterDetach(Buffer.from("after-detach\n"));
		child.finishChild();
		const outcome = (await request) as Extract<BashBackgroundOutcome, { status: "detached" }>;
		expect(outcome.status).toBe("detached");

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(await readFile(path!, "utf-8")).toBe("before\nafter-detach\n");
	});

	it("stops reporting output updates once the command is detached", async () => {
		const controller = createBashBackgroundController();
		const child = createDetachableOperations();
		const tool = createBashToolDefinition(process.cwd(), {
			operations: child.operations,
			exposeSessionEnvironment: false,
			background: controller,
		});

		const updates: string[] = [];
		const execute = tool.execute(
			"bg-updates",
			{ command: "x" },
			undefined,
			(partial) => {
				updates.push(textOf(partial as { content: Array<{ type: string; text?: string }> }));
			},
			{} as never,
		);
		const request = controller.request();
		const result = await execute;
		const updatesAtDetach = updates.length;

		// The agent loop has already dropped the update sink, so the tool must not keep snapshotting output.
		child.emitAfterDetach(Buffer.from("after-detach\n"));
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(updates.length).toBe(updatesAtDetach);

		child.finishChild();
		expect((await request).status).toBe("detached");
		expect(textOf(result)).toContain("detached");
	});

	it("reports an unsupported backend when the request arrives but the command finishes normally", async () => {
		const controller = createBashBackgroundController();
		let release: (() => void) | undefined;
		const operations = createPlainOperations({
			block: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		const tool = createBashToolDefinition(process.cwd(), {
			operations,
			exposeSessionEnvironment: false,
			background: controller,
		});

		const execute = tool.execute("bg-3", { command: "x" }, undefined, undefined, {} as never);
		const request = controller.request();
		release?.();
		const result = await execute;
		expect(textOf(result)).toContain("plain");
		expect(await request).toEqual({ status: "unsupported" });
		// Released after the outcome: the next request finds no running command.
		expect(await controller.request()).toEqual({ status: "no-command" });
	});

	it("releases the slot when the command finishes without a background request", async () => {
		const controller = createBashBackgroundController();
		let release: (() => void) | undefined;
		const operations = createPlainOperations({
			block: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		const tool = createBashToolDefinition(process.cwd(), {
			operations,
			exposeSessionEnvironment: false,
			background: controller,
		});

		const execute = tool.execute("bg-4", { command: "x" }, undefined, undefined, {} as never);
		await new Promise((resolve) => setTimeout(resolve, 10));
		release?.();
		await execute;
		// The slot is free again; the next request finds nothing running.
		expect(await controller.request()).toEqual({ status: "no-command" });
	});
});
