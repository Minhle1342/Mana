/**
 * Tests for the project .pi/extensions/grill-question.ts extension. Importing the
 * extension here is also what brings it under the root TypeScript check.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import grillQuestion from "../../../.pi/extensions/grill-question.ts";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ExtensionUIContext,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { Theme } from "../src/modes/interactive/theme/theme.ts";

const OTHER = "Other (type my own answer)";
const OPTIONS = ["A (recommended)", "B"];

const SPACE = " ";
const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

type GrillComponent = Component & { handleInput(data: string): void };

interface MultiContext {
	ctx: ExtensionToolContext;
	input: ReturnType<typeof vi.fn>;
	press(keys: string[]): void;
	render(): string;
}

function createTool(): ToolDefinition {
	let registered: ToolDefinition | undefined;
	const api = {
		registerTool(tool: ToolDefinition) {
			registered = tool;
		},
	} as unknown as ExtensionAPI;
	grillQuestion(api);
	if (!registered) throw new Error("grill-question extension did not register its tool");
	return registered;
}

const tool = createTool();

function text(result: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
	const part = result.content[0];
	return part?.type === "text" ? part.text : "";
}

function singleContext(
	select: ExtensionUIContext["select"],
	input: ExtensionUIContext["input"] = vi.fn(async () => undefined),
): ExtensionToolContext {
	return { hasUI: true, mode: "tui", ui: { select, input }, cwd: process.cwd() } as unknown as ExtensionToolContext;
}

function multiContext(typed?: string): MultiContext {
	let component: GrillComponent | undefined;
	const input = vi.fn(async () => typed);
	const custom = <T>(factory: unknown): Promise<T> =>
		new Promise<T>((resolve) => {
			component = (
				factory as (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (value: unknown) => void,
				) => GrillComponent
			)(
				{ requestRender: () => {} } as unknown as TUI,
				{ fg: (_color: string, value: string) => value } as unknown as Theme,
				new KeybindingsManager(),
				resolve as (value: unknown) => void,
			);
		});
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { custom, input },
		cwd: process.cwd(),
	} as unknown as ExtensionToolContext;
	return {
		ctx,
		input,
		press(keys) {
			if (!component) throw new Error("multi-select component was not created");
			for (const key of keys) component.handleInput(key);
		},
		render() {
			if (!component) throw new Error("multi-select component was not created");
			return component.render(80).join("\n");
		},
	};
}

function ask(context: ExtensionToolContext, multiple = false) {
	return tool.execute("call-1", { question: "Which one?", options: OPTIONS, multiple }, undefined, undefined, context);
}

describe("grill-question extension", () => {
	it("registers one sequential tool with prompt guidance", () => {
		expect(tool.name).toBe("grill_question");
		expect(tool.executionMode).toBe("sequential");
		expect(tool.promptGuidelines).toEqual([
			"In a grill-me interview, ask one grill_question per turn and put the recommended option first with (recommended).",
			"Set multiple: true when the user may pick more than one answer.",
		]);
		expect(tool.promptSnippet).toBeTruthy();
	});

	it("returns the chosen option without asking for text", async () => {
		const input = vi.fn(async () => "unused");
		const result = await ask(singleContext(async () => "B", input));
		expect(text(result)).toContain("The user chose: B");
		expect(input).not.toHaveBeenCalled();
	});

	it("returns typed text when the user picks Other", async () => {
		const context = singleContext(
			async () => OTHER,
			async () => "neither, buy it",
		);
		const result = await ask(context);
		expect(text(result)).toContain("The user typed: neither, buy it");
	});

	it("treats a blank Other answer as a dismissal", async () => {
		const dismissed = text(
			await ask(
				singleContext(
					async () => OTHER,
					async () => "   ",
				),
			),
		);
		expect(dismissed).toContain("dismissed");
		expect(dismissed).toContain("Which one?");
	});

	it("returns a dismissal when the picker is cancelled", async () => {
		const input = vi.fn(async () => "unused");
		const result = await ask(singleContext(async () => undefined, input));
		expect(text(result)).toContain("dismissed");
		expect(input).not.toHaveBeenCalled();
	});

	it("falls back to a numbered list without UI", async () => {
		const select = vi.fn<ExtensionUIContext["select"]>();
		const custom = vi.fn();
		const ctx = {
			hasUI: false,
			mode: "print",
			ui: { select, custom },
			cwd: process.cwd(),
		} as unknown as ExtensionToolContext;

		const answer = text(await ask(ctx));
		expect(answer).toContain("1. A (recommended)");
		expect(answer).toContain("2. B");
		expect(answer).toContain("number");
		expect(select).not.toHaveBeenCalled();
		expect(custom).not.toHaveBeenCalled();
	});

	it("renders a checkbox list and toggles two rows on the way to submit", async () => {
		const { ctx, press, render } = multiContext();
		const pending = ask(ctx, true);

		expect(render()).toContain("Which one?");
		expect(render()).toContain("[ ] A (recommended)");
		expect(render()).toContain(OTHER);
		expect(render()).toContain("Space toggle");

		press([SPACE, DOWN, SPACE]);
		expect(render()).toContain("[x] A (recommended)");
		expect(render()).toContain("[x] B");
		press([ENTER]);
		const answer = text(await pending);
		expect(answer).toContain("The user selected: A (recommended), B");
	});

	it("reports an empty set as selected nothing", async () => {
		const { ctx, press } = multiContext();
		const pending = ask(ctx, true);
		press([ENTER]);
		expect(text(await pending)).toContain("The user selected nothing");
	});

	it("appends typed text to the toggled set", async () => {
		const { ctx, input, press } = multiContext("keep it");
		const pending = ask(ctx, true);
		press([DOWN, SPACE, DOWN, ENTER]);
		const answer = text(await pending);
		expect(input).toHaveBeenCalled();
		expect(answer).toContain("The user selected: B");
		expect(answer).toContain("The user typed: keep it");
	});

	it("returns a dismissal when the checkbox list is cancelled", async () => {
		const { ctx, input, press } = multiContext("unused");
		const pending = ask(ctx, true);
		press([ESCAPE]);
		expect(text(await pending)).toContain("dismissed");
		expect(input).not.toHaveBeenCalled();
	});
});
