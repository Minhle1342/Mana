import type { Model } from "../../src/types.ts";
import { defineProvider } from "../define.ts";

// OmniRoute is a self-hosted AI router (default http://localhost:20128/v1)
// that routes each request to a provider the operator configured. Its model
// list is dynamic, so the catalog ships only the `auto` alias that is always
// available. Users add their own models under `omniroute` in models.json.
const BASE_URL = "http://localhost:20128/v1";

const MODELS: Model<"openai-completions">[] = [
	{
		id: "auto",
		name: "OmniRoute Auto",
		api: "openai-completions",
		provider: "omniroute",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000000,
		maxTokens: 4096,
	},
];

export default defineProvider({
	id: "omniroute",
	models: () => structuredClone(MODELS),
});
