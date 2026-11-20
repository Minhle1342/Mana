import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isDuckDuckGoChallenge,
	parseDuckDuckGoResults,
	searchDuckDuckGo,
} from "../src/extensions/web-search/duckduckgo.ts";
import { searchSearxng } from "../src/extensions/web-search/searxng.ts";
import { createWebSearchToolDefinition, WEB_SEARCH_TOOL_NAME } from "../src/extensions/web-search/tool.ts";

/** Captured shape of `https://html.duckduckgo.com/html/?q=...`, trimmed to two result blocks. */
const RESULTS_HTML = `<html><body>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fsinclairzx81%2Ftypebox&amp;rut=d4f5">GitHub - sinclairzx81/typebox: JSON Schema &amp; Type</a>
    </h2>
    <div class="result__extras">
      <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fsinclairzx81%2Ftypebox&amp;rut=d4f5">
        <img class="result__icon__img" src="//external-content.duckduckgo.com/ip3/github.com.ico" alt="" />
      </a>
    </div>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fsinclairzx81%2Ftypebox&amp;rut=d4f5"><b>TypeBox</b> is a runtime &quot;type&quot; system that infers <b>TypeScript</b> types.</a>
  </div>
</div>
<div class="result results_links results_links_deep web-result ">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2F%40sinclairzx81%2Ftypebox&amp;rut=ab12">@sinclairzx81/typebox - npm</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.npmjs.com%2Fpackage%2F%40sinclairzx81%2Ftypebox&amp;rut=ab12">TypeBox on npm &amp; more.</a>
  </div>
</div>
</body></html>`;

const CHALLENGE_HTML = `<html><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>
<form id="challenge-form" action="//duckduckgo.com/anomaly.js" method="POST"></form></body></html>`;

const signal = () => new AbortController().signal;

function textOf(result: { content: unknown[] }): string {
	const [first] = result.content;
	return first && typeof first === "object" && "text" in first ? String(first.text) : "";
}

beforeEach(() => {
	vi.stubEnv("PI_SEARXNG_URL", "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("parseDuckDuckGoResults", () => {
	it("reads titles and snippets as text and unwraps the redirect links", () => {
		expect(parseDuckDuckGoResults(RESULTS_HTML)).toEqual([
			{
				title: "GitHub - sinclairzx81/typebox: JSON Schema & Type",
				url: "https://github.com/sinclairzx81/typebox",
				snippet: 'TypeBox is a runtime "type" system that infers TypeScript types.',
			},
			{
				title: "@sinclairzx81/typebox - npm",
				url: "https://www.npmjs.com/package/@sinclairzx81/typebox",
				snippet: "TypeBox on npm & more.",
			},
		]);
	});

	it("returns nothing for a page without result blocks", () => {
		expect(parseDuckDuckGoResults("<html><body>Nothing here.</body></html>")).toEqual([]);
	});
});

describe("isDuckDuckGoChallenge", () => {
	it("recognises the anti-bot page and not a result page", () => {
		expect(isDuckDuckGoChallenge(CHALLENGE_HTML)).toBe(true);
		expect(isDuckDuckGoChallenge('<form id="challenge-form"></form>')).toBe(true);
		expect(isDuckDuckGoChallenge('<div class="anomaly-modal__title">bots</div>')).toBe(true);
		expect(isDuckDuckGoChallenge(RESULTS_HTML)).toBe(false);
	});
});

describe("searchDuckDuckGo", () => {
	it("requests the HTML endpoint once, with a user agent, and honours the limit", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(RESULTS_HTML, { status: 200, headers: { "content-type": "text/html" } }));

		const results = await searchDuckDuckGo("typebox", 1, signal());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [input, init] = fetchMock.mock.calls[0];
		expect(String(input)).toBe("https://html.duckduckgo.com/html/?q=typebox");
		expect(init?.headers).toMatchObject({ "user-agent": expect.stringContaining("pi") });
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://github.com/sinclairzx81/typebox");
	});

	it("turns the anti-bot page into an actionable error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(CHALLENGE_HTML, { status: 200 }));

		await expect(searchDuckDuckGo("typebox", 5, signal())).rejects.toThrow(
			"set PI_SEARXNG_URL to a SearXNG instance",
		);
	});

	it("reports the HTTP status of a failed request", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));

		await expect(searchDuckDuckGo("typebox", 5, signal())).rejects.toThrow("DuckDuckGo search failed: 503");
	});

	it("keeps a result whose snippet anchor is missing", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				'<div class="result results_links"><a class="result__a" href="https://example.com/a">A</a></div>',
				{
					status: 200,
				},
			),
		);

		const results = await searchDuckDuckGo("typebox", 5, signal());

		expect(results).toEqual([{ title: "A", url: "https://example.com/a", snippet: "" }]);
	});

	it("reports result blocks it could not parse instead of calling the search empty", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response('<div class="result results_links"><p>markup changed</p></div>', { status: 200 }),
		);

		await expect(searchDuckDuckGo("typebox", 5, signal())).rejects.toThrow("could not parse");
	});
});

describe("searchSearxng", () => {
	it("queries the JSON API and normalizes results to the tool shape", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ url: "https://example.com/a", title: "A", content: "Snippet A", engine: "brave" },
						{ url: "", title: "No URL", content: "dropped" },
						{ title: "No URL field", content: "dropped" },
						{ url: "https://example.com/b", title: "B", content: "Snippet B" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const results = await searchSearxng("https://searx.example", "typebox", 2, signal());

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [input, init] = fetchMock.mock.calls[0];
		expect(String(input)).toBe("https://searx.example/search?q=typebox&format=json");
		expect(init?.headers).toMatchObject({ accept: "application/json" });
		expect(results).toEqual([
			{ title: "A", url: "https://example.com/a", snippet: "Snippet A" },
			{ title: "B", url: "https://example.com/b", snippet: "Snippet B" },
		]);
	});

	it("names the json format setting on 403", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden", { status: 403 }));

		await expect(searchSearxng("https://searx.example", "typebox", 5, signal())).rejects.toThrow(
			'SearXNG refused the JSON API (403); enable "json" in search.formats.',
		);
	});

	it("carries the status and a body prefix of a failed request", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(1000), { status: 500 }));

		await expect(searchSearxng("https://searx.example", "typebox", 5, signal())).rejects.toThrow(
			`SearXNG search failed: 500: ${"x".repeat(512)}`,
		);
	});

	it("rejects a PI_SEARXNG_URL that is not an http(s) URL", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(searchSearxng("not a url", "typebox", 5, signal())).rejects.toThrow(
			"PI_SEARXNG_URL must be an http(s) URL: not a url",
		);
		await expect(searchSearxng("file:///etc/passwd", "typebox", 5, signal())).rejects.toThrow(
			"PI_SEARXNG_URL must be an http(s) URL: file:///etc/passwd",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps the instance path when the base URL has one", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));

		await searchSearxng("https://searx.example/searxng", "typebox", 5, signal());

		expect(String(fetchMock.mock.calls[0][0])).toBe("https://searx.example/searxng/search?q=typebox&format=json");
	});

	it("drops non-http result URLs and entries whose fields are not strings", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					results: [
						{ url: "javascript:alert(1)", title: "Script" },
						{ url: "file:///etc/passwd", title: "File" },
						{ url: "https://example.com/number-title", title: 5, content: 7 },
						{ url: "https://example.com/a", title: "A", content: "line one\n\n2. https://evil.example" },
						null,
					],
				}),
				{ status: 200 },
			),
		);

		const results = await searchSearxng("https://searx.example", "typebox", 5, signal());

		expect(results).toEqual([
			{ title: "A", url: "https://example.com/a", snippet: "line one 2. https://evil.example" },
		]);
	});

	it("treats a results field that is not an array as no results", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ results: { "0": { url: "https://a.example", title: "A" } } }), { status: 200 }),
		);

		expect(await searchSearxng("https://searx.example", "typebox", 5, signal())).toEqual([]);
	});

	it("names the json format setting when a 200 body is not JSON", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Forbidden</html>", { status: 200 }));

		await expect(searchSearxng("https://searx.example", "typebox", 5, signal())).rejects.toThrow(
			'SearXNG returned a non-JSON response from https://searx.example; check that search.formats includes "json"',
		);
	});
});

describe("web_search tool", () => {
	const tool = createWebSearchToolDefinition();
	const ctx = {} as Parameters<typeof tool.execute>[4];

	it("uses DuckDuckGo when PI_SEARXNG_URL is unset", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(RESULTS_HTML, { status: 200 }));

		const result = await tool.execute("call-1", { query: "typebox" }, signal(), undefined, ctx);

		expect(String(fetchMock.mock.calls[0][0])).toContain("https://html.duckduckgo.com/html/");
		expect(result.details).toEqual({ provider: "DuckDuckGo", resultCount: 2 });
		expect(textOf(result)).toContain("https://github.com/sinclairzx81/typebox");
		expect(textOf(result)).toContain("Source: DuckDuckGo");
	});

	it("uses SearXNG when PI_SEARXNG_URL is set", async () => {
		vi.stubEnv("PI_SEARXNG_URL", "https://searx.example");
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ results: [{ url: "https://example.com/a", title: "A", content: "Snippet A" }] }),
				{
					status: 200,
				},
			),
		);

		const result = await tool.execute("call-1", { query: "typebox" }, signal(), undefined, ctx);

		expect(String(fetchMock.mock.calls[0][0])).toContain("https://searx.example/search");
		expect(result.details).toEqual({ provider: "SearXNG", resultCount: 1 });
		expect(textOf(result)).toContain("Source: SearXNG");
	});

	it("rejects bad parameters before any request", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");

		await expect(tool.execute("call-1", { query: "  " }, signal(), undefined, ctx)).rejects.toThrow(
			"query must not be empty",
		);
		await expect(tool.execute("call-2", { query: "x", max_results: 0 }, signal(), undefined, ctx)).rejects.toThrow(
			"max_results must be a positive integer",
		);
		await expect(tool.execute("call-3", { query: "x", max_results: 1.5 }, signal(), undefined, ctx)).rejects.toThrow(
			"max_results must be a positive integer",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("renders an empty result set as no results", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html><body></body></html>", { status: 200 }));

		const result = await tool.execute("call-1", { query: "typebox" }, signal(), undefined, ctx);

		expect(textOf(result)).toBe("No results.\n\nSource: DuckDuckGo");
		expect(result.details).toEqual({ provider: "DuckDuckGo", resultCount: 0 });
	});

	it("is named and declared as a direct tool", () => {
		expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
		expect(tool.exposure ?? "direct").toBe("direct");
		expect(tool.promptSnippet).toContain(WEB_SEARCH_TOOL_NAME);
	});
});
