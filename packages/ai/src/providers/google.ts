import { googleGenerativeAIApi } from "../api/google-generative-ai.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadGoogleOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { GOOGLE_MODELS } from "./google.models.ts";

export function googleProvider(): Provider<"google-generative-ai"> {
	return createProvider({
		id: "google",
		name: "Google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		auth: {
			apiKey: envApiKeyAuth("Gemini API key", ["GEMINI_API_KEY"]),
			oauth: lazyOAuth({
				name: "Google (Google Pro)",
				isSubscription: true,
				loginLabel: "Sign in with Google",
				load: loadGoogleOAuth,
			}),
		},
		models: Object.values(GOOGLE_MODELS),
		api: googleGenerativeAIApi(),
	});
}
