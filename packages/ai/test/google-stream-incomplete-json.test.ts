import { GoogleGenAI } from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { stream as streamGoogleGenerativeAi } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
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
});
