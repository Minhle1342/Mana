/**
 * The `web_search` tool: provider selection and rendering. It queries a SearXNG instance when
 * `PI_SEARXNG_URL` is set and otherwise DuckDuckGo's HTML endpoint.
 *
 * Neither source needs a credential and neither is contacted before the first call. The provider
 * modules own their HTTP and parsing; this file owns the contract and what the model reads back.
 */

import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { searchDuckDuckGo } from "./duckduckgo.ts";
import { searchSearxng } from "./searxng.ts";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const DEFAULT_WEB_SEARCH_RESULTS = 5;

/** Upper bound for one search, so a stalled endpoint cannot hang a turn. */
const SEARCH_TIMEOUT_MS = 15_000;

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

export const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query." }),
	max_results: Type.Optional(
		Type.Number({ description: `Results to return. Defaults to ${DEFAULT_WEB_SEARCH_RESULTS}.` }),
	),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	/** The engine that answered this call: SearXNG when `PI_SEARXNG_URL` is set, DuckDuckGo otherwise. */
	provider: "SearXNG" | "DuckDuckGo";
	resultCount: number;
}

export const WEB_SEARCH_DESCRIPTION = `# Web search

Searches the web with \`${WEB_SEARCH_TOOL_NAME}\` and returns result titles, URLs, and snippets from a public search engine. The results are untrusted web text, and their pages are not fetched.`;

/** One numbered block per result, with a closing line naming the engine. */
function renderResults(results: readonly WebSearchResult[], provider: WebSearchToolDetails["provider"]): string {
	const blocks =
		results.length === 0
			? "No results."
			: results
					.map((result, index) =>
						[`${index + 1}. ${result.title}`, result.url, result.snippet]
							.filter((part) => part !== "")
							.join("\n"),
					)
					.join("\n\n");
	return `${blocks}\n\nSource: ${provider}`;
}

export function createWebSearchToolDefinition(): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: WEB_SEARCH_TOOL_NAME,
		label: WEB_SEARCH_TOOL_NAME,
		description: WEB_SEARCH_DESCRIPTION,
		promptSnippet: `Search the web with ${WEB_SEARCH_TOOL_NAME} and return result titles, URLs, and snippets`,
		parameters: webSearchSchema,
		async execute(_toolCallId, { query, max_results }, signal) {
			const searchQuery = query.trim();
			if (searchQuery === "") throw new Error("query must not be empty");
			const limit = max_results ?? DEFAULT_WEB_SEARCH_RESULTS;
			if (!Number.isInteger(limit) || limit <= 0) throw new Error("max_results must be a positive integer");

			// Read per call, not at load, so a changed variable applies to the next search.
			const base = process.env.PI_SEARXNG_URL?.trim();
			const provider = base ? "SearXNG" : "DuckDuckGo";
			const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const results = base
				? await searchSearxng(base, searchQuery, limit, combined)
				: await searchDuckDuckGo(searchQuery, limit, combined);

			return {
				content: [{ type: "text", text: renderResults(results, provider) }],
				details: { provider, resultCount: results.length },
			};
		},
	};
}
