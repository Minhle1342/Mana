import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { googleOAuth } from "../src/auth/oauth/google.ts";
import { createModels } from "../src/models.ts";
import { googleProvider } from "../src/providers/google.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const nativeFetch = globalThis.fetch;
const neverAbortedSignal = new AbortController().signal;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe.sequential("Google OAuth", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("is exposed alongside API-key auth on the google provider", () => {
		const provider = googleProvider();
		expect(provider.auth.apiKey).toBeDefined();
		expect(provider.auth.oauth).toBeDefined();
		expect(provider.auth.oauth?.name).toBe("Google (Google Pro)");
		expect(provider.auth.oauth?.isSubscription).toBe(true);
		expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Google");
	});

	it("includes gemini-3.8-flash in the models list", () => {
		const provider = googleProvider();
		const flash38 = provider.getModels().find((model) => model.id === "gemini-3.8-flash");
		expect(flash38).toBeDefined();
		expect(flash38?.name).toBe("Gemini 3.8 Flash");
	});

	it("toAuth maps credentials to apiKey and Authorization header", async () => {
		const auth = await googleOAuth.toAuth({
			type: "oauth",
			access: "ya29.test-access-token",
			refresh: "test-refresh-token",
			expires: Date.now() + 3600_000,
		});

		expect(auth.apiKey).toBe("ya29.test-access-token");
		expect(auth.headers?.Authorization).toBe("Bearer ya29.test-access-token");
	});

	it("resolves stored OAuth credentials through Models.getAuth", async () => {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("google", async () => ({
			type: "oauth",
			access: "ya29.stored-token",
			refresh: "refresh-token",
			expires: Date.now() + 3600_000,
		}));

		const models = createModels({ credentials });
		models.setProvider(googleProvider());
		const geminiModel = models.getModel("google", "gemini-3.8-flash");
		expect(geminiModel).toBeDefined();

		const auth = await models.getAuth(geminiModel!);
		expect(auth?.auth.apiKey).toBe("ya29.stored-token");
		expect(auth?.auth.headers?.Authorization).toBe("Bearer ya29.stored-token");
	});

	it("performs OAuth authorization code exchange with PKCE via manual code", async () => {
		let tokenRequestBody: string | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === TOKEN_URL) {
				tokenRequestBody = String(init?.body);
				return jsonResponse({
					access_token: "ya29.issued-access-token",
					refresh_token: "issued-refresh-token",
					expires_in: 3600,
				});
			}
			return nativeFetch(input, init);
		});
		vi.stubGlobal("fetch", fetchMock);

		let authUrl = "";
		const credential = await googleOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async (prompt) => {
				if (prompt.type !== "manual_code") throw new Error(`Unexpected prompt: ${prompt.type}`);
				const url = new URL(authUrl);
				const state = url.searchParams.get("state");
				const redirectUri = url.searchParams.get("redirect_uri");
				return `${redirectUri}?code=google-auth-code&state=${state}`;
			},
		});

		expect(credential.type).toBe("oauth");
		expect(credential.access).toBe("ya29.issued-access-token");
		expect(credential.refresh).toBe("issued-refresh-token");
		expect(credential.expires).toBeGreaterThan(Date.now());

		expect(tokenRequestBody).toBeDefined();
		const params = new URLSearchParams(tokenRequestBody);
		expect(params.get("code")).toBe("google-auth-code");
		expect(params.get("grant_type")).toBe("authorization_code");
		expect(params.get("code_verifier")).toBeDefined();
	});

	it("refreshes expired OAuth tokens", async () => {
		let tokenRequestBody: string | undefined;
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === TOKEN_URL) {
				tokenRequestBody = String(init?.body);
				return jsonResponse({
					access_token: "ya29.refreshed-token",
					expires_in: 1800,
				});
			}
			return nativeFetch(input, init);
		});
		vi.stubGlobal("fetch", fetchMock);

		const refreshed = await googleOAuth.refresh(
			{
				type: "oauth",
				access: "ya29.old-token",
				refresh: "my-refresh-token",
				expires: Date.now() - 1000,
			},
			neverAbortedSignal,
		);

		expect(refreshed.access).toBe("ya29.refreshed-token");
		expect(refreshed.refresh).toBe("my-refresh-token");
		expect(refreshed.expires).toBeGreaterThan(Date.now());

		const params = new URLSearchParams(tokenRequestBody);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("my-refresh-token");
	});

	it("requests only pre-approved scopes to avoid 403 restricted_client", async () => {
		let authUrl = "";
		const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === TOKEN_URL) {
				return jsonResponse({
					access_token: "ya29.test",
					expires_in: 3600,
				});
			}
			return nativeFetch(input, init);
		});
		vi.stubGlobal("fetch", fetchMock);

		await googleOAuth.login({
			signal: neverAbortedSignal,
			notify: (event) => {
				if (event.type === "auth_url") authUrl = event.url;
			},
			prompt: async () => {
				const url = new URL(authUrl);
				return `${url.searchParams.get("redirect_uri")}?code=test-code&state=${url.searchParams.get("state")}`;
			},
		});

		const url = new URL(authUrl);
		const requestedScopes = url.searchParams.get("scope")?.split(" ") ?? [];
		expect(requestedScopes).toContain("https://www.googleapis.com/auth/cloud-platform");
		expect(requestedScopes).toContain("https://www.googleapis.com/auth/userinfo.email");
		expect(requestedScopes).toContain("https://www.googleapis.com/auth/userinfo.profile");
		expect(requestedScopes).not.toContain("https://www.googleapis.com/auth/generative-language.retriever");
	});
});
