import { GoogleGenAI } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { createGoogleFetch, sanitizeGoogleSseStream } from "../src/api/google-shared.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

function createSseStream(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
			}
			controller.close();
		},
	});
}

describe("@google/genai stream parsing behavior", () => {
	it("reproduces Error('Incomplete JSON segment at the end') when final SSE chunk ends with single newline", async () => {
		const sseBody = createSseStream(['data: {"candidates":[{"content":{"parts":[{"text":"Hello world"}]}}]}\n']);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
		);

		try {
			const client = new GoogleGenAI({ apiKey: "test-key" });
			const stream = await client.models.generateContentStream({
				model: "gemini-3.5-flash-lite",
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
			});

			let caughtError: unknown;
			try {
				for await (const _chunk of stream) {
					// Consume chunks
				}
			} catch (err) {
				caughtError = err;
			}

			expect(caughtError).toBeInstanceOf(Error);
			expect((caughtError as Error).message).toBe("Incomplete JSON segment at the end");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reproduces Error('Incomplete JSON segment at the end') when stream ends with trailing keepalive comment or whitespace", async () => {
		const sseBody = createSseStream([
			'data: {"candidates":[{"content":{"parts":[{"text":"Part 1"}]}}]}\n\n',
			": keep-alive\n",
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
		);

		try {
			const client = new GoogleGenAI({ apiKey: "test-key" });
			const stream = await client.models.generateContentStream({
				model: "gemini-3.5-flash-lite",
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
			});

			const receivedChunks: unknown[] = [];
			let caughtError: unknown;
			try {
				for await (const chunk of stream) {
					receivedChunks.push(chunk);
				}
			} catch (err) {
				caughtError = err;
			}

			// First chunk was valid and parsed successfully
			expect(receivedChunks).toHaveLength(1);
			// But trailing comment without double newline caused fatal error
			expect(caughtError).toBeInstanceOf(Error);
			expect((caughtError as Error).message).toBe("Incomplete JSON segment at the end");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("reproduces Error('Incomplete JSON segment at the end') when connection is truncated mid-JSON during tool call", async () => {
		const sseBody = createSseStream([
			'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"write_file","args":{"path":"app.ts","content":"console.log(',
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
		);

		try {
			const client = new GoogleGenAI({ apiKey: "test-key" });
			const stream = await client.models.generateContentStream({
				model: "gemini-3.5-flash-lite",
				contents: [{ role: "user", parts: [{ text: "hi" }] }],
			});

			let caughtError: unknown;
			try {
				for await (const _chunk of stream) {
					// Consume
				}
			} catch (err) {
				caughtError = err;
			}

			expect(caughtError).toBeInstanceOf(Error);
			expect((caughtError as Error).message).toBe("Incomplete JSON segment at the end");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Google Generative AI adapter stream recovery", () => {
	it("recovers already received text when stream ends with trailing incomplete segment error", async () => {
		const sseBody = createSseStream([
			'data: {"candidates":[{"content":{"parts":[{"text":"Here is the full answer."}]}}]}\n\n',
			'data: {"candidates":[{"content":{"parts":[{"text":"Half',
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
		);

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			// Successfully recovered: the complete text is preserved and stopReason is stop
			expect(message.stopReason).toBe("stop");
			expect(message.errorMessage).toBeUndefined();
			expect(message.content).toEqual([{ type: "text", text: "Here is the full answer." }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("recovers completed tool call when stream ends with trailing incomplete segment error", async () => {
		const sseBody = createSseStream([
			'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"read_file","args":{"path":"test.txt"}}}]}}]}\n\n',
			'data: {"candidates":[{"content":{"parts":[{"text":"Half',
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
		);

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "read file", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			// Successfully recovered: the tool call is preserved and stopReason is toolUse
			expect(message.stopReason).toBe("toolUse");
			expect(message.errorMessage).toBeUndefined();
			expect(message.content[0].type).toBe("toolCall");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("recovers completed tool call on Google Vertex", async () => {
		const sseBody = createSseStream([
			'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"call_1","name":"read_file","args":{"path":"test.txt"}}}]}}]}\n\n',
			'data: {"candidates":[{"content":{"parts":[{"text":"Half',
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockResolvedValue(
			new Response(sseBody, {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			}),
		);

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "read file", timestamp: Date.now() }],
			});

			const stream = streamGoogleVertex(getModel("google-vertex", "gemini-3-flash-preview"), context, {
				apiKey: "test-api-key",
				project: "test-project",
				location: "us-central1",
			});

			const message = await stream.result();

			expect(message.stopReason).toBe("toolUse");
			expect(message.errorMessage).toBeUndefined();
			expect(message.content[0].type).toBe("toolCall");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("retries when stream fails before any content is emitted", async () => {
		let attempt = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			attempt++;
			if (attempt === 1) {
				return new Response(createSseStream([": keep-alive\n"]), {
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				});
			}
			return new Response(
				createSseStream([
					'data: {"candidates":[{"content":{"parts":[{"text":"Success on retry"}]},"finishReason":"STOP"}]}\n\n',
				]),
				{
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		});

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			expect(attempt).toBe(2);
			expect(message.stopReason).toBe("stop");
			expect(message.errorMessage).toBeUndefined();
			expect(message.content).toEqual([{ type: "text", text: "Success on retry" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("retries when stream drops during thinking phase before any text is emitted", async () => {
		let attempt = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			attempt++;
			if (attempt === 1) {
				// Attempt 1: model emits thinking, but then connection cuts mid-stream
				return new Response(
					createSseStream([
						'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Let me ponder this..."}]}}]}\n\n',
						'data: {"candidates":[{"content":{"parts":[{"text":"Halfwa',
					]),
					{
						status: 200,
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			}
			// Attempt 2: retry succeeds with complete text
			return new Response(
				createSseStream([
					'data: {"candidates":[{"content":{"parts":[{"text":"Complete answer after thinking failure"}]},"finishReason":"STOP"}]}\n\n',
				]),
				{
					status: 200,
					headers: { "Content-Type": "text/event-stream" },
				},
			);
		});

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "think and answer", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			expect(attempt).toBe(2);
			expect(message.stopReason).toBe("stop");
			expect(message.errorMessage).toBeUndefined();
			expect(message.content).toEqual([{ type: "text", text: "Complete answer after thinking failure" }]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Google adapter stream boundaries", () => {
	it("reports a stream that ends without a finish reason as an error", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi
			.fn()
			.mockResolvedValue(
				new Response(
					createSseStream(['data: {"candidates":[{"content":{"parts":[{"text":"Half an answer"}]}}]}\n\n']),
					{ status: 200, headers: { "Content-Type": "text/event-stream" } },
				),
			);

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			expect(message.stopReason).toBe("error");
			expect(message.errorMessage).toContain("without a finish reason");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not retry once text was emitted", async () => {
		let attempt = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			attempt++;
			return new Response(
				createSseStream([
					'data: {"candidates":[{"content":{"parts":[{"text":"Partial answer"}]}}]}\n\n',
					'data: {"candidates":[{"content":{"parts":[{"text":"Half',
				]),
				{ status: 200, headers: { "Content-Type": "text/event-stream" } },
			);
		});

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			expect(attempt).toBe(1);
			expect(message.stopReason).toBe("stop");
			expect(message.errorMessage).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("does not attribute a retried failure to the discarded attempt's finish reason", async () => {
		let attempt = 0;
		const originalFetch = globalThis.fetch;
		globalThis.fetch = vi.fn().mockImplementation(async () => {
			attempt++;
			const chunks =
				attempt === 1
					? [
							'data: {"candidates":[{"finishReason":"SAFETY"}]}\n\n',
							'data: {"candidates":[{"content":{"parts":[{"text":"Half',
						]
					: ['data: {"candidates":[{"content":{"parts":[{"text":"Complete answer"}]}}]}\n\n'];
			return new Response(createSseStream(chunks), {
				status: 200,
				headers: { "Content-Type": "text/event-stream" },
			});
		});

		try {
			const context = normalizeContext({
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			});

			const stream = streamGoogleGenerativeAi(getModel("google", "gemini-2.5-flash"), context, {
				apiKey: "test-api-key",
			});

			const message = await stream.result();

			expect(attempt).toBe(2);
			expect(message.errorMessage).toContain("without a finish reason");
			expect(message.errorMessage).not.toContain("SAFETY");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("createGoogleFetch", () => {
	it("returns a non-streaming response unchanged", async () => {
		const response = new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
		const fetchFn = createGoogleFetch(async () => response);

		expect(await fetchFn("https://example.com/v1beta/models")).toBe(response);
	});

	it("returns an error response unchanged so the SDK can read its body", async () => {
		const response = new Response("denied", { status: 403 });
		const fetchFn = createGoogleFetch(async () => response);

		expect(await fetchFn("https://example.com/v1beta/models:streamGenerateContent?alt=sse")).toBe(response);
	});

	it("replaces the body of an event stream and keeps status and headers", async () => {
		const source = createSseStream(['data: {"ok":true}\n']);
		const response = new Response(source, { status: 200, headers: { "content-type": "text/event-stream" } });
		const fetchFn = createGoogleFetch(async () => response);

		const wrapped = await fetchFn("https://example.com/v1beta/models:streamGenerateContent?alt=sse");

		expect(wrapped.body).not.toBe(source);
		expect(wrapped.status).toBe(200);
		expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
		const reader = wrapped.body?.getReader();
		if (!reader) throw new Error("expected a body");
		const decoder = new TextDecoder();
		let text = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
		expect(text).toBe('data: {"ok":true}\n\n\n');
	});
});

describe("sanitizeGoogleSseStream", () => {
	async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		let result = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			result += decoder.decode(value, { stream: true });
		}
		result += decoder.decode();
		return result;
	}

	it("appends double newline when stream ends with single newline on valid json", async () => {
		const rawStream = createSseStream(['data: {"hello":"world"}\n']);
		const sanitized = sanitizeGoogleSseStream(rawStream);
		const result = await readAll(sanitized);
		expect(result).toBe('data: {"hello":"world"}\n\n\n');
	});

	it("appends double newline when stream ends with comment", async () => {
		const rawStream = createSseStream(['data: {"ok":true}\n\n: keep-alive\n']);
		const sanitized = sanitizeGoogleSseStream(rawStream);
		const result = await readAll(sanitized);
		expect(result).toBe('data: {"ok":true}\n\n: keep-alive\n\n\n');
	});

	it("leaves stream untouched when already ending with double newline", async () => {
		const rawStream = createSseStream(['data: {"ok":true}\n\n']);
		const sanitized = sanitizeGoogleSseStream(rawStream);
		const result = await readAll(sanitized);
		expect(result).toBe('data: {"ok":true}\n\n');
	});

	it("does not complete truncated mid-json chunk", async () => {
		const rawStream = createSseStream(['data: {"broken":']);
		const sanitized = sanitizeGoogleSseStream(rawStream);
		const result = await readAll(sanitized);
		expect(result).toBe('data: {"broken":');
	});

	it("tracks a delimiter split across two chunks", async () => {
		const encoder = new TextEncoder();
		const sanitized = sanitizeGoogleSseStream(
			createSseStream([encoder.encode('data: {"ok":true}\n'), encoder.encode("\n"), encoder.encode("data: {}")]),
		);

		const result = await readAll(sanitized);

		// The first event already ended with `\n\n`, so nothing is appended for it.
		expect(result).toBe('data: {"ok":true}\n\ndata: {}\n\n');
	});

	it("passes a multibyte character split across chunks through unchanged", async () => {
		const bytes = new TextEncoder().encode('data: {"t":"héllo"}\n\n');
		const splitAt = bytes.indexOf(0xc3) + 1;
		const sanitized = sanitizeGoogleSseStream(createSseStream([bytes.slice(0, splitAt), bytes.slice(splitAt)]));

		expect(await readAll(sanitized)).toBe('data: {"t":"héllo"}\n\n');
	});

	it("forwards cancel to the source stream", async () => {
		const cancelled: unknown[] = [];
		const source = new ReadableStream<Uint8Array>({
			pull() {
				// Never enqueues: the consumer cancels before the first pull resolves.
			},
			cancel(reason) {
				cancelled.push(reason);
			},
		});

		await sanitizeGoogleSseStream(source).cancel("stop");

		expect(cancelled).toEqual(["stop"]);
	});

	it("keeps the tracking buffer bounded on a stream of comments", async () => {
		const sanitized = sanitizeGoogleSseStream(createSseStream([": keep-alive\n".repeat(8000), 'data: {"ok":true}']));

		const result = await readAll(sanitized);

		// The buffer was trimmed, but the tail still decides the closing delimiter.
		expect(result.endsWith("\n\n")).toBe(true);
	});
});
