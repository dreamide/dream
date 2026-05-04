import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_MODELS_CACHE_FILE = path.join(
  os.homedir(),
  ".codex",
  "models_cache.json",
);

const readCodexAuthFile = async () => {
  try {
    const contents = await fs.readFile(CODEX_AUTH_FILE, "utf8");
    return JSON.parse(contents);
  } catch {
    return null;
  }
};

export const readCodexAccessToken = async () => {
  const authData = await readCodexAuthFile();

  if (!authData) {
    return null;
  }

  return authData.tokens?.access_token?.trim() || null;
};

export const readCodexChatGptAuthTokens = async () => {
  const authData = await readCodexAuthFile();
  const accessToken = authData?.tokens?.access_token?.trim();

  if (!accessToken) {
    return null;
  }

  return {
    accessToken,
    chatgptAccountId: authData?.tokens?.account_id ?? "",
    chatgptPlanType: null,
  };
};

export const readCodexModelsCache = async () => {
  try {
    const contents = await fs.readFile(CODEX_MODELS_CACHE_FILE, "utf8");
    const parsed = JSON.parse(contents);
    return Array.isArray(parsed.models) ? parsed.models : [];
  } catch {
    return [];
  }
};
