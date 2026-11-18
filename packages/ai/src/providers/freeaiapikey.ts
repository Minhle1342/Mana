import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { envApiKeyAuth } from "../auth/helpers.ts";
import { createProvider, type Provider } from "../models.ts";
import { FREEAIAPIKEY_MODELS } from "./freeaiapikey.models.ts";

export function freeaiapikeyProvider(): Provider<"openai-completions"> {
	return createProvider({
		id: "freeaiapikey",
		name: "FreeAIapiKey",
		baseUrl: "https://api.freeaiapikey.com/v1",
		auth: { apiKey: envApiKeyAuth("FreeAIapiKey API key", ["FREEAIAPIKEY_API_KEY"]) },
		models: Object.values(FREEAIAPIKEY_MODELS),
		api: openAICompletionsApi(),
	});
}
