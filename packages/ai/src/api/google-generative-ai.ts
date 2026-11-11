import {
	type GenerateContentConfig,
	type GenerateContentParameters,
	GoogleGenAI,
	type GoogleGenAIOptions,
	type ThinkingConfig,
} from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	ProviderHeaders,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { providerHeadersToRecord } from "../utils/headers.ts";
import { type ClientIdentity, getIdentityHeaders } from "../utils/identity.ts";
import { getProviderEnvValue } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./google-shared.ts";
import {
	canRecoverFromIncompleteJsonError,
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReason,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	resolveIncompleteJsonStopReason,
	retainThoughtSignature,
	retryGoogleRequest,
	supportsGoogleStrictToolSampling,
	toGoogleSdkThinkingLevel,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

export interface GoogleOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number; // -1 for dynamic, 0 to disable
		level?: GoogleApiThinkingLevel;
	};
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

export const stream: StreamFunction<"google-generative-ai", GoogleOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: GoogleOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-generative-ai" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			if (options?.fetch && options.fetch !== globalThis.fetch) {
				throw new Error("Custom fetch is not supported by the Google Generative AI adapter");
			}
			const apiKey = options?.apiKey;
			const hasAuthHeader = Boolean(options?.headers?.Authorization || options?.headers?.authorization);
			if (!apiKey && !hasAuthHeader) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}
			const client = createClient(model, apiKey, options?.headers, options?.identity);
			let params = buildParams(model, normalizedContext, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as GenerateContentParameters;
			}
			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;

			const maxRetries = options?.maxRetries ?? 2;
			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				const googleStream = await retryGoogleRequest(() => client.models.generateContentStream(params), options);

				try {
					for await (const chunk of googleStream) {
						await options?.onProviderStreamEvent?.(chunk, model);
						// @google/genai documents GenerateContentResponse.responseId as an output-only field
						// used to identify each response. Keep the first non-empty one from the stream.
						output.responseId ||= chunk.responseId;
						const candidate = chunk.candidates?.[0];
						if (candidate?.content?.parts) {
							for (const part of candidate.content.parts) {
								if (part.text !== undefined) {
									const isThinking = isThinkingPart(part);
									if (
										!currentBlock ||
										(isThinking && currentBlock.type !== "thinking") ||
										(!isThinking && currentBlock.type !== "text")
									) {
										if (currentBlock) {
											if (currentBlock.type === "text") {
												stream.push({
													type: "text_end",
													contentIndex: blocks.length - 1,
													content: currentBlock.text,
													partial: output,
												});
											} else {
												stream.push({
													type: "thinking_end",
													contentIndex: blockIndex(),
													content: currentBlock.thinking,
													partial: output,
												});
											}
										}
										if (isThinking) {
											currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
											output.content.push(currentBlock);
											stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
										} else {
											currentBlock = { type: "text", text: "" };
											output.content.push(currentBlock);
											stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
										}
									}
									if (currentBlock.type === "thinking") {
										currentBlock.thinking += part.text;
										currentBlock.thinkingSignature = retainThoughtSignature(
											currentBlock.thinkingSignature,
											part.thoughtSignature,
										);
										stream.push({
											type: "thinking_delta",
											contentIndex: blockIndex(),
											delta: part.text,
											partial: output,
										});
									} else {
										currentBlock.text += part.text;
										currentBlock.textSignature = retainThoughtSignature(
											currentBlock.textSignature,
											part.thoughtSignature,
										);
										stream.push({
											type: "text_delta",
											contentIndex: blockIndex(),
											delta: part.text,
											partial: output,
										});
									}
								}

								if (part.functionCall) {
									if (currentBlock) {
										if (currentBlock.type === "text") {
											stream.push({
												type: "text_end",
												contentIndex: blockIndex(),
												content: currentBlock.text,
												partial: output,
											});
										} else {
											stream.push({
												type: "thinking_end",
												contentIndex: blockIndex(),
												content: currentBlock.thinking,
												partial: output,
											});
										}
										currentBlock = null;
									}

									// Generate unique ID if not provided or if it's a duplicate
									const providedId = part.functionCall.id;
									const needsNewId =
										!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
									const toolCallId = needsNewId
										? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
										: providedId;

									const toolCall: ToolCall = {
										type: "toolCall",
										id: toolCallId,
										name: part.functionCall.name || "",
										arguments: (part.functionCall.args as Record<string, any>) ?? {},
										...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
									};

									output.content.push(toolCall);
									stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
									stream.push({
										type: "toolcall_delta",
										contentIndex: blockIndex(),
										delta: JSON.stringify(toolCall.arguments),
										partial: output,
									});
									stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
								}
							}
						}

						if (candidate?.finishReason) {
							output.rawStopReason = candidate.finishReason;
							output.stopReason = mapStopReason(candidate.finishReason);
							if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
								output.stopReason = "toolUse";
							}
						}

						if (chunk.usageMetadata) {
							output.usage = {
								input:
									(chunk.usageMetadata.promptTokenCount || 0) -
									(chunk.usageMetadata.cachedContentTokenCount || 0),
								output:
									(chunk.usageMetadata.candidatesTokenCount || 0) +
									(chunk.usageMetadata.thoughtsTokenCount || 0),
								cacheRead: chunk.usageMetadata.cachedContentTokenCount || 0,
								cacheWrite: 0,
								reasoning: chunk.usageMetadata.thoughtsTokenCount || 0,
								totalTokens: chunk.usageMetadata.totalTokenCount || 0,
								cost: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									total: 0,
								},
							};
							calculateCost(model, output.usage);
						}
					}
					break;
				} catch (err) {
					if (canRecoverFromIncompleteJsonError(err, output)) {
						if (output.stopReason === "pending") {
							output.stopReason = resolveIncompleteJsonStopReason(output);
						}
						break;
					}
					if (output.content.length === 0 && attempt < maxRetries && !options?.signal?.aborted) {
						output.responseId = undefined;
						continue;
					}
					throw err;
				}
			}

			if (currentBlock) {
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "pending") {
				throw new Error("Google stream ended without a finish reason");
			}
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				const errorMessage = output.rawStopReason
					? `Provider stopped with: ${output.rawStopReason}`
					: "An unknown error occurred";
				throw new Error(errorMessage);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatGoogleError(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-generative-ai", SimpleStreamOptions> = (
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey;
	const hasAuthHeader = Boolean(options?.headers?.Authorization || options?.headers?.authorization);
	if (!apiKey && !hasAuthHeader) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = {
		...buildBaseOptions(model, context, options, apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleOptions;
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}

	const clampedReasoning = clampThinkingLevel(model, options.reasoning);
	if (clampedReasoning === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } } satisfies GoogleOptions);
	}
	const resolvedLevel = resolveGoogleThinkingLevel(model, clampedReasoning);

	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, {
			...base,
			thinking: {
				enabled: true,
				level: toGoogleThinkingLevel(resolvedLevel),
			},
		} satisfies GoogleOptions);
	}

	return stream(model, context, {
		...base,
		thinking: {
			enabled: true,
			budgetTokens: getGoogleBudget(model, resolvedLevel, options.thinkingBudgets),
		},
	} satisfies GoogleOptions);
};

function isOAuthToken(apiKey?: string): boolean {
	return typeof apiKey === "string" && (apiKey.startsWith("ya29.") || apiKey.startsWith("Bearer "));
}

function createClient(
	model: Model<"google-generative-ai">,
	apiKey?: string,
	optionsHeaders?: ProviderHeaders,
	identity?: ClientIdentity,
): GoogleGenAI {
	const httpOptions: { baseUrl?: string; apiVersion?: string; headers?: Record<string, string> } = {};
	if (model.baseUrl) {
		httpOptions.baseUrl = model.baseUrl;
		httpOptions.apiVersion = ""; // baseUrl already includes version path, don't append
	}
	const headers = providerHeadersToRecord(getIdentityHeaders(model, identity), model.headers, optionsHeaders);
	if (headers) {
		httpOptions.headers = headers;
	}

	const userProject = getProviderEnvValue("GOOGLE_CLOUD_PROJECT") || getProviderEnvValue("GCLOUD_PROJECT");
	if (userProject && !httpOptions.headers?.["x-goog-user-project"] && !httpOptions.headers?.["X-Goog-User-Project"]) {
		httpOptions.headers = { ...httpOptions.headers, "x-goog-user-project": userProject };
	}

	const isOAuth =
		isOAuthToken(apiKey) || Boolean(httpOptions.headers?.Authorization || httpOptions.headers?.authorization);

	if (isOAuth) {
		const rawToken =
			(typeof apiKey === "string" && apiKey) ||
			(typeof httpOptions.headers?.Authorization === "string" ? httpOptions.headers.Authorization : undefined) ||
			(typeof httpOptions.headers?.authorization === "string" ? httpOptions.headers.authorization : undefined);
		const token = rawToken?.replace(/^Bearer\s+/i, "");

		const authHeaders = new Headers();
		if (token) {
			authHeaders.set("authorization", `Bearer ${token}`);
		}

		// When authenticating with an OAuth token (e.g. Google Pro user account sign-in),
		// @google/genai requires a custom authClient so NodeAuth does not attempt to resolve
		// Application Default Credentials (ADC) from the local machine.
		const authClient = {
			getRequestHeaders: async () => authHeaders,
		};

		return new GoogleGenAI({
			apiKey: undefined,
			googleAuthOptions: {
				authClient: authClient as unknown as NonNullable<GoogleGenAIOptions["googleAuthOptions"]>["authClient"],
			},
			httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
		});
	}

	return new GoogleGenAI({
		apiKey,
		httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,
	});
}

function buildParams(
	model: Model<"google-generative-ai">,
	context: TranscriptContext,
	options: GoogleOptions = {},
): GenerateContentParameters {
	const contents = convertMessages(model, context);
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);

	const generationConfig: GenerateContentConfig = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}

	const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
	const functionCallingMode =
		currentTools.length > 0
			? resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode)
			: undefined;
	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemInstruction && { systemInstruction: sanitizeSurrogates(systemInstruction) }),
		...(currentTools.length > 0 && {
			tools: convertTools(currentTools, false, supportsStrictMode),
		}),
		...(functionCallingMode !== undefined && {
			toolConfig: { functionCallingConfig: { mode: functionCallingMode } },
		}),
	};

	if (options.thinking?.enabled && model.reasoning) {
		const thinkingConfig: ThinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			thinkingConfig.thinkingLevel = toGoogleSdkThinkingLevel(options.thinking.level);
		} else if (options.thinking.budgetTokens !== undefined) {
			thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = thinkingConfig;
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		config.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new Error("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	const params: GenerateContentParameters = {
		model: model.id,
		contents,
		config,
	};

	return params;
}

function getGoogleBudget(
	model: Model<"google-generative-ai">,
	level: ResolvedGoogleThinkingLevel,
	customBudgets?: ThinkingBudgets,
): number {
	if (customBudgets?.[level] !== undefined) {
		return customBudgets[level]!;
	}

	if (model.id.includes("2.5-pro")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 32768,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash-lite")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 512,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	if (model.id.includes("2.5-flash")) {
		const budgets: Record<ResolvedGoogleThinkingLevel, number> = {
			minimal: 128,
			low: 2048,
			medium: 8192,
			high: 24576,
		};
		return budgets[level];
	}

	return -1;
}

function formatGoogleError(error: unknown): string {
	const message = formatProviderError(normalizeProviderError(error));
	if (message.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
		return (
			"Google OAuth token has insufficient scopes for Google AI Studio (generativelanguage.googleapis.com). " +
			"Consumer Google Pro / Google One AI subscriptions do not grant Google AI Studio API access via OAuth. " +
			"To use Gemini models, please sign in using a Gemini API key from https://aistudio.google.com/apikey, " +
			"or set GOOGLE_OAUTH_CLIENT_ID with generative-language scopes, or use the google-vertex provider with a GCP project."
		);
	}
	return message;
}
