import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});

	test("fires the click handler for a left click only", () => {
		initTheme("dark");
		const onClick = vi.fn();
		const component = new UserMessageComponent("hello", undefined, 1, [], undefined, undefined, onClick);
		const lines = component.render(20);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 20,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};

		expect(component.handleMouse({ ...event, button: "right" })).toBeUndefined();
		expect(onClick).not.toHaveBeenCalled();

		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(onClick).toHaveBeenCalledOnce();
	});

	test("passes persisted entry identity in transformer context; live leaves it undefined", () => {
		initTheme("dark");
		const captured: Array<{ messageId?: string; timestamp?: string }> = [];
		const capture = (_markdown: string, context: { messageId?: string; timestamp?: string }) => {
			captured.push({ messageId: context.messageId, timestamp: context.timestamp });
			return _markdown;
		};

		new UserMessageComponent("restored", undefined, 1, [capture], "entry-abc", "2025-01-15T10:30:00.000Z").render(80);
		new UserMessageComponent("live", undefined, 1, [capture]).render(80);

		expect(captured).toEqual([
			{ messageId: "entry-abc", timestamp: "2025-01-15T10:30:00.000Z" },
			{ messageId: undefined, timestamp: undefined },
		]);
	});
});
