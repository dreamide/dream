import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface CodexAuthTokens {
  access_token?: string;
}

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  auth_mode?: string;
  tokens?: CodexAuthTokens;
}

type CodexCredentialSource = "apiKey" | "chatgpt" | "none";

export interface CodexCredential {
  authMode: string;
  credential: string | null;
  source: CodexCredentialSource;
}

export interface CodexAuthStatus {
  authMode: string;
  loggedIn: boolean;
  message: string;
}

const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");

const readCodexAuthFile = async (): Promise<CodexAuthFile | null> => {
  try {
    const contents = await fs.readFile(CODEX_AUTH_FILE, "utf8");
    return JSON.parse(contents) as CodexAuthFile;
  } catch {
    return null;
  }
};

export const readCodexCredential = async (): Promise<CodexCredential> => {
  const authData = await readCodexAuthFile();

  if (!authData) {
    return {
      authMode: "unknown",
      credential: null,
      source: "none",
    };
  }

  const authMode = authData.auth_mode ?? "unknown";
  const accessToken = authData.tokens?.access_token?.trim();

  if (accessToken) {
    return {
      authMode,
      credential: accessToken,
      source: "chatgpt",
    };
  }

  const apiKey = authData.OPENAI_API_KEY?.trim();
  if (apiKey) {
    return {
      authMode,
      credential: apiKey,
      source: "apiKey",
    };
  }

  return {
    authMode,
    credential: null,
    source: "none",
  };
};

export const getCodexAuthStatus = async (): Promise<CodexAuthStatus> => {
  const credential = await readCodexCredential();

  if (!credential.credential) {
    return {
      authMode: credential.authMode,
      loggedIn: false,
      message:
        credential.authMode === "unknown"
          ? "Not logged in. Run `codex login` in your terminal."
          : "Codex auth file found, but no usable credential is available.",
    };
  }

  return {
    authMode: credential.authMode,
    loggedIn: true,
    message:
      credential.source === "chatgpt"
        ? `Logged in with ChatGPT via Codex (${credential.authMode}).`
        : `Logged in with API key via Codex (${credential.authMode}).`,
  };
};
