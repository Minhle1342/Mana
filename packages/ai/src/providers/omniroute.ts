import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { OMNIROUTE_MODELS } from "./omniroute.models.ts";

export function omnirouteProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "omniroute",
		name: "OmniRoute",
		baseUrl: "http://localhost:20128/v1",
		auth: { apiKey: envApiKeyAuth("OmniRoute API key", ["OMNIROUTE_API_KEY"]) },
		models: Object.values(OMNIROUTE_MODELS),
		api: openAICompletionsApi(),
	});
}
