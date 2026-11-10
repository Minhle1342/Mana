import { beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	streamImplementation: undefined as ((params: unknown) => AsyncIterable<unknown>) | undefined,
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		constructor(config: Record<string, unknown>) {
			googleGenAiMock.constructorCalls.push(config);
		}

		models = {
			generateContentStream: (params: unknown) => {
				if (googleGenAiMock.streamImplementation) {
					return googleGenAiMock.streamImplementation(params);
				}
				return (async function* () {
					yield {
						responseId: "google-response-id",
						candidates: [
							{
								finishReason: "STOP",
								content: { parts: [{ text: "response" }] },
							},
						],
						usageMetadata: {
							promptTokenCount: 1,
							candidatesTokenCount: 1,
							totalTokenCount: 2,
						},
					};
				})();
			},
		};
	}

	return {
		GoogleGenAI,
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
		},
	};
});

import { stream } from "../src/api/google-generative-ai.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("Google Generative AI OAuth streaming", () => {
	beforeEach(() => {
		googleGenAiMock.constructorCalls.length = 0;
		googleGenAiMock.streamImplementation = undefined;
	});

	it("passes Bearer token in headers and omits apiKey when using OAuth token", async () => {
		const model = getBuiltinModel("google", "gemini-3.8-flash");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		});

		const response = stream(model, context, {
			apiKey: "ya29.test-oauth-token",
		});

		const result = await response.result();
		expect(result.stopReason).toBe("stop");
		expect(googleGenAiMock.constructorCalls).toHaveLength(1);

		const call = googleGenAiMock.constructorCalls[0];
		expect(call.apiKey).toBeUndefined();
		const googleAuthOptions = call.googleAuthOptions as
			| { authClient?: { getRequestHeaders: () => Promise<Headers> } }
			| undefined;
		expect(googleAuthOptions?.authClient).toBeDefined();
		const authHeaders = await googleAuthOptions!.authClient!.getRequestHeaders();
		expect(authHeaders.get("authorization")).toBe("Bearer ya29.test-oauth-token");
	});

	it("passes apiKey to GoogleGenAI when using regular API key", async () => {
		const model = getBuiltinModel("google", "gemini-3.8-flash");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		});

		const response = stream(model, context, {
			apiKey: "AIzaSyRegularApiKey",
		});

		const result = await response.result();
		expect(result.stopReason).toBe("stop");
		expect(googleGenAiMock.constructorCalls).toHaveLength(1);

		const call = googleGenAiMock.constructorCalls[0];
		expect(call.apiKey).toBe("AIzaSyRegularApiKey");
	});

	it("formats ACCESS_TOKEN_SCOPE_INSUFFICIENT error with clear actionable guidance", async () => {
		googleGenAiMock.streamImplementation = () => {
			const error = new Error(
				JSON.stringify({
					error: {
						code: 403,
						message: "Request had insufficient authentication scopes.",
						status: "PERMISSION_DENIED",
						details: [
							{
								"@type": "type.googleapis.com/google.rpc.ErrorInfo",
								reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
								metadata: {
									method: "google.ai.generativelanguage.v1beta.GenerativeService.StreamGenerateContent",
									service: "generativelanguage.googleapis.com",
								},
							},
						],
					},
				}),
			);
			(error as any).status = 403;
			throw error;
		};

		const model = getBuiltinModel("google", "gemini-3.8-flash");
		const context = normalizeContext({
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		});

		const response = stream(model, context, {
			apiKey: "ya29.insufficient-scope-token",
		});

		const result = await response.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Google OAuth token has insufficient scopes for Google AI Studio");
		expect(result.errorMessage).toContain("https://aistudio.google.com/apikey");
	});
});
