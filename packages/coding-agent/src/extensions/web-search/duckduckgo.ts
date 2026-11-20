/**
 * DuckDuckGo search through its no-JavaScript HTML endpoint: the fallback `web_search` backend used
 * when `PI_SEARXNG_URL` is unset.
 *
 * DuckDuckGo rate-limits this endpoint by answering an anti-bot challenge instead of results, so the
 * fallback is best effort; {@link isDuckDuckGoChallenge} turns that page into an actionable error
 * rather than an empty result list.
 */

import { VERSION } from "../../config.ts";
import { decodeHtmlEntityAt } from "../../utils/html.ts";
import { getPiUserAgent } from "../../utils/pi-user-agent.ts";
import type { WebSearchResult } from "./tool.ts";

const DUCKDUCKGO_HTML_URL = "https://html.duckduckgo.com/html/";

/** Result blocks start here; each block holds one link and one snippet anchor. */
const RESULT_BLOCK_START = '<div class="result results_links';

const RESULT_LINK = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;

const RESULT_SNIPPET = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/;

// Shortcut: regexes over DuckDuckGo's HTML class names. Replace them with a real HTML parser if the
// markup changes more than once a year.

/** Whether the body is DuckDuckGo's anti-bot page instead of results. */
export function isDuckDuckGoChallenge(html: string): boolean {
	return html.includes('id="challenge-form"') || html.includes('class="anomaly-modal');
}

/** Parse result blocks out of a DuckDuckGo results page, in page order. */
export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
	const results: WebSearchResult[] = [];
	for (const block of html.split(RESULT_BLOCK_START).slice(1)) {
		const link = RESULT_LINK.exec(block);
		if (!link) continue;
		const url = unwrapResultUrl(link[1]);
		if (!url) continue;
		const title = decodeHtmlText(link[2]);
		if (title === "") continue;
		// A block without its snippet anchor still names a result; the renderer tolerates an empty snippet.
		const snippet = RESULT_SNIPPET.exec(block);
		results.push({ title, url, snippet: snippet ? decodeHtmlText(snippet[1]) : "" });
	}
	return results;
}

/** Query DuckDuckGo's HTML endpoint, at most `limit` results. */
export async function searchDuckDuckGo(query: string, limit: number, signal: AbortSignal): Promise<WebSearchResult[]> {
	const url = new URL(DUCKDUCKGO_HTML_URL);
	url.searchParams.set("q", query);
	const response = await fetch(url, {
		signal,
		headers: { accept: "text/html", "user-agent": getPiUserAgent(VERSION) },
	});
	if (!response.ok) throw new Error(`DuckDuckGo search failed: ${response.status}`);
	const body = await response.text();
	if (isDuckDuckGoChallenge(body)) {
		throw new Error(
			"DuckDuckGo returned an anti-bot challenge; set PI_SEARXNG_URL to a SearXNG instance for reliable web search.",
		);
	}
	const results = parseDuckDuckGoResults(body);
	// Blocks that none of them parsed mean the markup moved, not that the search found nothing.
	if (results.length === 0 && body.includes(RESULT_BLOCK_START)) {
		throw new Error(
			"DuckDuckGo returned results this tool could not parse (its markup changed); set PI_SEARXNG_URL to a SearXNG instance for reliable web search.",
		);
	}
	return results.slice(0, limit);
}

/**
 * The result URL behind DuckDuckGo's redirect link: `/l/?uddg=<target>` on `duckduckgo.com`, in a
 * protocol-relative `href`. Anything that is not `http(s)` is dropped, since the model would copy it.
 */
function unwrapResultUrl(href: string): string | undefined {
	const absolute = href.replace(/&amp;/g, "&").replace(/^\/\//, "https://");
	let url: URL;
	try {
		url = new URL(absolute);
	} catch {
		return undefined;
	}
	const unwrapped =
		url.hostname === "duckduckgo.com" && url.pathname === "/l/"
			? (url.searchParams.get("uddg") ?? undefined)
			: absolute;
	return unwrapped?.startsWith("http://") || unwrapped?.startsWith("https://") ? unwrapped : undefined;
}

/**
 * Result text as plain text: tags removed, entities decoded, whitespace collapsed. An entity the
 * shared decoder does not know keeps its `&`, so the text stays readable instead of losing a character.
 */
function decodeHtmlText(html: string): string {
	const text = html.replace(/<[^>]*>/g, "");
	let decoded = "";
	let index = 0;
	while (index < text.length) {
		if (text[index] === "&") {
			const entity = decodeHtmlEntityAt(text, index);
			if (entity) {
				decoded += entity.text;
				index += entity.length;
				continue;
			}
			decoded += "&";
			index += 1;
			continue;
		}
		decoded += text[index];
		index += 1;
	}
	return decoded.replace(/\s+/g, " ").trim();
}
