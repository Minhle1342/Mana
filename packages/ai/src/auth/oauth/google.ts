/**
 * Google OAuth PKCE flow (Google Pro / Google account sign-in)
 *
 * NOTE: This module is lazily loaded and only intended for CLI use,
 * not browser environments.
 */

import { getProviderEnvValue } from "../../utils/provider-env.ts";
import type { OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../types.ts";
import { startOAuthCallbackServer, waitForCallbackOrManualInput } from "./callback-server.ts";
import { generatePKCE } from "./pkce.ts";

const decode = (s: string) => atob(s);
const DEFAULT_CLIENT_ID = decode(
	"NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
);
const DEFAULT_CLIENT_SECRET = decode("R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=");
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_HOST = getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") || "127.0.0.1";
const CALLBACK_PORT = 8085;
const CALLBACK_PATH = "/oauth2callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const DEFAULT_SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
].join(" ");

function getClientId(): string {
	return getProviderEnvValue("GOOGLE_OAUTH_CLIENT_ID") || getProviderEnvValue("GOOGLE_CLIENT_ID") || DEFAULT_CLIENT_ID;
}

function getClientSecret(): string {
	return (
		getProviderEnvValue("GOOGLE_OAUTH_CLIENT_SECRET") ||
		getProviderEnvValue("GOOGLE_CLIENT_SECRET") ||
		DEFAULT_CLIENT_SECRET
	);
}

function getScopes(): string {
	return getProviderEnvValue("GOOGLE_OAUTH_SCOPES") || DEFAULT_SCOPES;
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

async function exchangeAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string,
	signal: AbortSignal,
): Promise<OAuthCredential> {
	if (signal.aborted) throw new Error("Login cancelled");
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: getClientId(),
			client_secret: getClientSecret(),
			code,
			grant_type: "authorization_code",
			redirect_uri: redirectUri,
			code_verifier: verifier,
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Google OAuth token exchange failed (HTTP ${response.status}): ${text}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token) {
		throw new Error("Google OAuth token response carried no access_token");
	}

	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
	const expires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;

	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token ?? "",
		expires,
	};
}

async function refreshGoogleToken(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential> {
	if (!credential.refresh) {
		throw new Error("Cannot refresh Google OAuth token: no refresh token available. Please sign in again.");
	}
	if (signal.aborted) throw new Error("Login cancelled");

	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
		},
		body: new URLSearchParams({
			client_id: getClientId(),
			client_secret: getClientSecret(),
			refresh_token: credential.refresh,
			grant_type: "refresh_token",
		}),
		signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`Google OAuth token refresh failed (HTTP ${response.status}): ${text}`);
	}

	const data = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!data.access_token) {
		throw new Error("Google OAuth token refresh response carried no access_token");
	}

	const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
	const expires = Date.now() + expiresIn * 1000 - 5 * 60 * 1000;

	return {
		type: "oauth",
		access: data.access_token,
		refresh: data.refresh_token ?? credential.refresh,
		expires,
	};
}

async function loginGoogle(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
	const { verifier, challenge } = await generatePKCE();
	const startCallbackServer = (port: number) =>
		startOAuthCallbackServer({
			providerName: "Google",
			host: CALLBACK_HOST,
			port,
			path: CALLBACK_PATH,
			redirectHost: "localhost",
			state: verifier,
			complete: async (code) => code,
			signal: interaction.signal,
		});

	const callback = await startCallbackServer(CALLBACK_PORT)
		.catch(() => startCallbackServer(0))
		.catch(() => undefined);
	const redirectUri = callback?.redirectUri ?? REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			client_id: getClientId(),
			response_type: "code",
			redirect_uri: redirectUri,
			scope: getScopes(),
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
			access_type: "offline",
			prompt: "consent",
		});

		interaction.notify({
			type: "auth_url",
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		const result = await waitForCallbackOrManualInput(interaction, callback, {
			message: "Complete login in your browser, or paste the authorization code / redirect URL here:",
			placeholder: redirectUri,
		});
		let code: string | undefined;
		if (result.type === "callback") {
			code = result.value;
		} else {
			const parsed = parseAuthorizationInput(result.input);
			if (parsed.state && parsed.state !== verifier) throw new Error("OAuth state mismatch");
			code = parsed.code;
		}

		if (!code) throw new Error("Missing authorization code");
		interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
		return await exchangeAuthorizationCode(code, verifier, redirectUri, interaction.signal);
	} finally {
		callback?.close();
	}
}

export const googleOAuth: OAuthAuth = {
	name: "Google (Google Pro)",
	isSubscription: true,
	loginLabel: "Sign in with Google",
	login: loginGoogle,
	refresh: refreshGoogleToken,
	async toAuth(credential) {
		return {
			apiKey: credential.access,
			headers: { Authorization: `Bearer ${credential.access}` },
		};
	},
};
