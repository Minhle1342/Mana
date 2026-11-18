/**
 * grill-question extension: one question with suggested answers, shown as a
 * single-choice picker, a multi-select checkbox list, or a numbered text
 * fallback when no dialog can be rendered.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER = "Other (type my own answer)";

const GrillParams = Type.Object({
	question: Type.String({ description: "The question to show." }),
	options: Type.Array(Type.String(), {
		minItems: 2,
		maxItems: 5,
		description: "Suggested answers, recommended first.",
	}),
	multiple: Type.Optional(Type.Boolean({ description: "Let the user toggle several answers." })),
});

interface GrillDetails {
	question: string;
	options: string[];
	answers: string[];
	dismissed: boolean;
}

export default function grillQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "grill_question",
		label: "Grill question",
		description:
			"Ask the user one question with 2-5 suggested answers shown as a picker or a checkbox list. Returns the chosen answer(s) or the user's own text.",
		promptSnippet: "Ask one question with suggested answers in a picker",
		promptGuidelines: [
			"In a grill-me interview, ask one grill_question per turn and put the recommended option first with (recommended).",
			"Set multiple: true when the user may pick more than one answer.",
		],
		parameters: GrillParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { question, options, multiple } = params;

			// A numbered list keeps the interview possible where no dialog renders:
			// no UI at all, or a mode whose custom components are ignored.
			if (!ctx.hasUI || (multiple && ctx.mode !== "tui")) {
				return result(numberedFallback(question, options), params, [], false);
			}

			if (!multiple) {
				const chosen = await ctx.ui.select(question, [...options, OTHER]);
				if (chosen === undefined) return dismissal(question, options);
				if (chosen !== OTHER) return result(`The user chose: ${chosen}`, params, [chosen], false);
				const typed = (await ctx.ui.input(question, "Type your answer"))?.trim();
				if (!typed) return dismissal(question, options);
				return result(`The user typed: ${typed}`, params, [typed], false);
			}

			const picked = await pickMany(ctx, question, options);
			if (!picked) return dismissal(question, options);
			const typed = picked.other
				? (await ctx.ui.input(question, "Type your answer"))?.trim() || undefined
				: undefined;
			// Enter on the Other row with nothing typed is the only multi dismissal:
			// Enter alone elsewhere is an explicit "none of these".
			if (picked.answers.length === 0 && !typed && picked.other) return dismissal(question, options);

			const lines = picked.answers.length
				? [`The user selected: ${picked.answers.join(", ")}`]
				: ["The user selected nothing"];
			if (typed) lines.push(`The user typed: ${typed}`);
			return result(lines.join("\n"), params, typed ? [...picked.answers, typed] : picked.answers, false);
		},
	});
}

function numberedFallback(question: string, options: string[]): string {
	return [
		question,
		...options.map((option, index) => `${index + 1}. ${option}`),
		"Reply with the number of your answer, or type your own answer.",
	].join("\n");
}

function dismissal(question: string, options: string[]): AgentToolResult<GrillDetails> {
	return result(
		`The user dismissed the question without answering: ${question}`,
		{ question, options },
		[],
		true,
	);
}

function result(
	text: string,
	params: { question: string; options: string[] },
	answers: string[],
	dismissed: boolean,
): AgentToolResult<GrillDetails> {
	return {
		content: [{ type: "text", text }],
		details: { question: params.question, options: params.options, answers, dismissed },
	};
}

/** Checkbox list for a multi-answer question; `other: true` means Enter was pressed on the Other row. */
async function pickMany(
	ctx: ExtensionToolContext,
	question: string,
	options: string[],
): Promise<{ answers: string[]; other: boolean } | null> {
	const rows = [...options, OTHER];
	return ctx.ui.custom<{ answers: string[]; other: boolean } | null>((tui, theme, keybindings, done) => {
		let cursor = 0;
		const toggled = new Set<number>();

		function handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.up")) {
				cursor = Math.max(0, cursor - 1);
				tui.requestRender();
				return;
			}
			if (keybindings.matches(data, "tui.select.down")) {
				cursor = Math.min(rows.length - 1, cursor + 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "space")) {
				if (cursor < options.length) {
					if (toggled.has(cursor)) toggled.delete(cursor);
					else toggled.add(cursor);
					tui.requestRender();
				}
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm")) {
				const answers = options.filter((_option, index) => toggled.has(index));
				done({ answers, other: cursor === options.length });
				return;
			}
			if (keybindings.matches(data, "tui.select.cancel")) done(null);
		}

		function render(width: number): string[] {
			const renderWidth = Math.max(1, width);
			const lines = [
				theme.fg("accent", "─".repeat(renderWidth)),
				truncateToWidth(` ${theme.fg("text", question)}`, renderWidth),
				"",
			];
			for (let index = 0; index < rows.length; index++) {
				const selected = index === cursor;
				const label = index === options.length ? rows[index] : `${toggled.has(index) ? "[x]" : "[ ]"} ${rows[index]}`;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				lines.push(truncateToWidth(`${prefix}${theme.fg(selected ? "accent" : "text", label)}`, renderWidth));
			}
			lines.push("", theme.fg("dim", "↑↓ move • Space toggle • Enter submit • Esc cancel"));
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			return lines;
		}

		return {
			render,
			invalidate: () => {},
			handleInput,
		};
	});
}
