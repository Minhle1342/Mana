/**
 * SearXNG search: the preferred `web_search` backend, selected by `PI_SEARXNG_URL`.
 *
 * SearXNG exposes `GET /search?q=<query>&format=json`. Its JSON format is off by default, so a stock
 * instance answers 403 until `search.formats` includes `json`; the error says so.
 */

import { VERSION } from "../../config.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import { webUrl } from "../../utils/web-url.ts";
import type { WebSearchResult } from "./tool.ts";

/** First part of an error body kept in the message; the rest is progress dots and markup. */
const ERROR_BODY_LIMIT = 512;

/** One wire result. Every field is `unknown` because this is JSON from an instance, not our data. */
interface SearxngResult {
	url?: unknown;
	title?: unknown;
	content?: unknown;
}

/** Query a SearXNG instance and return its results in order, at most `limit` of them. */
export async function searchSearxng(
	baseUrl: string,
	query: string,
	limit: number,
	signal: AbortSignal,
): Promise<WebSearchResult[]> {
	// Wire input from the operator's environment: only an http(s) base can be fetched.
	const base = webUrl(baseUrl);
	if (!base) throw new Error(`PI_SEARXNG_URL must be an http(s) URL: ${baseUrl}`);
	// A relative reference alone would drop the last segment of a base that has no trailing slash.
	const url = new URL("search", base.endsWith("/") ? base : `${base}/`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	const response = await fetch(url, {
		signal,
		headers: { accept: "application/json", "user-agent": getPiUserAgent(VERSION) },
	});
	if (!response.ok) {
		const body = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		const hint =
			response.status === 403 ? 'SearXNG refused the JSON API (403); enable "json" in search.formats. ' : "";
		throw new Error(`${hint}SearXNG search failed: ${response.status}: ${body}`);
	}

	const payload = await readJsonBody(response, url.origin);
	const results: WebSearchResult[] = [];
	for (const entry of Array.isArray(payload.results) ? payload.results : []) {
		if (typeof entry !== "object" || entry === null) continue;
		const { url: resultUrl, title, content } = entry as SearxngResult;
		if (typeof resultUrl !== "string" || typeof title !== "string") continue;
		// Only http(s) reaches the model: it copies these, so a `javascript:` or `file:` URL must not.
		const target = webUrl(resultUrl);
		const text = oneLine(title);
		if (!target || text === "") continue;
		results.push({ title: text, url: target, snippet: typeof content === "string" ? oneLine(content) : "" });
		if (results.length === limit) break;
	}
	return results;
}

/**
 * The response body as JSON. A 200 that is not JSON is a proxy or an instance without the `json`
 * format rather than an empty result set, so the message names the instance instead of the parser.
 */
async function readJsonBody(response: Response, origin: string): Promise<{ results?: unknown }> {
	const text = await response.text();
	try {
		return JSON.parse(text) as { results?: unknown };
	} catch {
		throw new Error(`SearXNG returned a non-JSON response from ${origin}; check that search.formats includes "json"`);
	}
}

/** Result text on one line: a hidden newline in a snippet would forge extra entries in the rendered list. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
