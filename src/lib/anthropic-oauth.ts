import { createHash, randomBytes } from "node:crypto";

const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_REDIRECT_URI =
  "https://console.anthropic.com/oauth/code/callback";
const ANTHROPIC_OAUTH_SCOPE = "org:create_api_key user:profile user:inference";
const ANTHROPIC_OAUTH_TOKEN_URL =
  "https://console.anthropic.com/v1/oauth/token";

export const ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER =
  "oauth-2025-04-20,interleaved-thinking-2025-05-14";

export type AnthropicOAuthMode = "max" | "console";

export interface AnthropicOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const toBase64Url = (input: Buffer): string => {
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const generateAnthropicPkceVerifier = (): string => {
  return toBase64Url(randomBytes(48));
};

const getPkceChallenge = (verifier: string): string => {
  return toBase64Url(createHash("sha256").update(verifier).digest());
};

export const createAnthropicAuthorizationUrl = (
  mode: AnthropicOAuthMode,
  verifier: string,
): string => {
  const url = new URL(
    `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`,
  );
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_REDIRECT_URI);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPE);
  url.searchParams.set("code_challenge", getPkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", verifier);
  return url.toString();
};

const parseAnthropicCode = (
  codeInput: string,
): { code: string; state?: string } => {
  const [code = "", state] = codeInput.trim().split("#");
  return { code, state };
};

const parseOAuthTokenResponse = async (
  response: Response,
): Promise<AnthropicOAuthTokens> => {
  if (!response.ok) {
    throw new Error(`Anthropic OAuth request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  const accessToken = payload.access_token?.trim() ?? "";
  const refreshToken = payload.refresh_token?.trim() ?? "";
  const expiresIn = payload.expires_in ?? 0;

  if (!accessToken || !refreshToken || !expiresIn) {
    throw new Error(
      "Anthropic OAuth response is missing required token fields.",
    );
  }

  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
    refreshToken,
  };
};

export const exchangeAnthropicAuthorizationCode = async (
  codeInput: string,
  verifier: string,
): Promise<AnthropicOAuthTokens> => {
  const { code, state } = parseAnthropicCode(codeInput);

  if (!code) {
    throw new Error("Authorization code is required.");
  }

  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    body: JSON.stringify({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: ANTHROPIC_OAUTH_REDIRECT_URI,
      state,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  return parseOAuthTokenResponse(response);
};

export const refreshAnthropicAccessToken = async (
  refreshToken: string,
): Promise<AnthropicOAuthTokens> => {
  const token = refreshToken.trim();
  if (!token) {
    throw new Error("Refresh token is required.");
  }

  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    body: JSON.stringify({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: token,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  return parseOAuthTokenResponse(response);
};
