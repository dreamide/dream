import { z } from "zod";
import {
  ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER,
  refreshAnthropicAccessToken,
} from "@/lib/anthropic-oauth";
import { readCodexCredential } from "@/lib/codex-auth";
import {
  createModelOption,
  dedupeModelOptions,
  type ModelOption,
} from "@/lib/models";
import type { AnthropicAuthMode, OpenAiAuthMode } from "@/types/ide";

export const runtime = "nodejs";

const requestBodySchema = z.object({
  anthropicAccessToken: z.string().optional(),
  anthropicAccessTokenExpiresAt: z.number().nullable().optional(),
  anthropicAuthMode: z.enum(["apiKey", "claudeProMax"]).default("apiKey"),
  anthropicApiKey: z.string().optional(),
  anthropicRefreshToken: z.string().optional(),
  geminiApiKey: z.string().optional(),
  openAiApiKey: z.string().optional(),
  openAiAuthMode: z.enum(["apiKey", "codex"]).default("apiKey"),
});

type ModelSource = "api" | "unavailable";

interface ProviderModelResult {
  models: ModelOption[];
  source: ModelSource;
  error?: string;
  oauth?: {
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
  };
}

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_CODEX_CHATGPT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const GEMINI_OPENAI_MODELS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/models";
const CODEX_CLIENT_VERSION = "1.0.0";

const dedupeAndSort = (models: ModelOption[]): ModelOption[] => {
  return dedupeModelOptions(models)
    .sort((a, b) => a.id.localeCompare(b.id))
    .reverse();
};

const isOpenAiChatModel = (model: string): boolean => {
  return model.startsWith("gpt-") || /^o\d/.test(model);
};

const fetchOpenAiModelsWithApiKey = async (
  apiKey: string,
): Promise<ModelOption[]> => {
  const response = await fetch(OPENAI_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ id?: string }>;
  };

  const modelIds = (payload.data ?? []).flatMap((entry) => {
    const id = entry.id?.trim() ?? "";
    return id ? [id] : [];
  });
  const chatModels = modelIds.filter((model) => isOpenAiChatModel(model));

  return dedupeAndSort(
    (chatModels.length > 0 ? chatModels : modelIds).map((id) =>
      createModelOption("openai", id),
    ),
  );
};

const fetchOpenAiModelsWithCodexChatgpt = async (
  accessToken: string,
): Promise<ModelOption[]> => {
  const url = new URL(OPENAI_CODEX_CHATGPT_MODELS_URL);
  url.searchParams.set("client_version", CODEX_CLIENT_VERSION);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    method: "GET",
  });

  if (!response.ok) {
    throw new Error(`Codex model request failed (${response.status}).`);
  }

  const payload = (await response.json()) as {
    models?: Array<{
      display_name?: string;
      slug?: string;
    }>;
  };

  const modelIds = (payload.models ?? []).flatMap((entry) => {
    const id = entry.slug?.trim() ?? "";
    if (!id) {
      return [];
    }

    return [createModelOption("openai", id, entry.display_name)];
  });

  return dedupeAndSort(modelIds);
};

const fetchOpenAiModels = async (
  authMode: OpenAiAuthMode,
  openAiApiKey: string,
): Promise<ProviderModelResult> => {
  if (authMode === "apiKey") {
    if (!openAiApiKey) {
      return {
        error: "Add an OpenAI API key to fetch the latest model list.",
        models: [],
        source: "unavailable",
      };
    }

    try {
      const models = await fetchOpenAiModelsWithApiKey(openAiApiKey);
      if (models.length === 0) {
        return {
          error: "OpenAI returned no models.",
          models: [],
          source: "unavailable",
        };
      }

      return { models, source: "api" };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch OpenAI models.",
        models: [],
        source: "unavailable",
      };
    }
  }

  const codexCredential = await readCodexCredential();
  if (!codexCredential.credential) {
    return {
      error: "Run `codex login` to fetch Codex models.",
      models: [],
      source: "unavailable",
    };
  }

  if (codexCredential.source === "chatgpt") {
    try {
      const models = await fetchOpenAiModelsWithCodexChatgpt(
        codexCredential.credential,
      );
      if (models.length === 0) {
        return {
          error: "Codex returned no models.",
          models: [],
          source: "unavailable",
        };
      }

      return { models, source: "api" };
    } catch (error) {
      return {
        error:
          error instanceof Error
            ? error.message
            : "Unable to fetch Codex models.",
        models: [],
        source: "unavailable",
      };
    }
  }

  try {
    const models = await fetchOpenAiModelsWithApiKey(
      codexCredential.credential,
    );
    if (models.length === 0) {
      return {
        error: "OpenAI returned no models.",
        models: [],
        source: "unavailable",
      };
    }

    return { models, source: "api" };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch OpenAI models.",
      models: [],
      source: "unavailable",
    };
  }
};

interface AnthropicOAuthInput {
  accessToken: string;
  expiresAt: number | null;
  refreshToken: string;
}

const isAnthropicTokenExpired = (expiresAt: number | null): boolean => {
  if (typeof expiresAt !== "number") {
    return true;
  }

  return expiresAt <= Date.now() + 15_000;
};

const fetchAnthropicModelsWithOAuth = async (
  oauthInput: AnthropicOAuthInput,
): Promise<ProviderModelResult> => {
  const refreshToken = oauthInput.refreshToken.trim();

  if (!refreshToken) {
    return {
      error: "Log in with Claude Pro/Max before fetching models.",
      models: [],
      source: "unavailable",
    };
  }

  let tokens = {
    accessToken: oauthInput.accessToken.trim(),
    expiresAt: oauthInput.expiresAt,
    refreshToken,
  };

  try {
    if (!tokens.accessToken || isAnthropicTokenExpired(tokens.expiresAt)) {
      const refreshed = await refreshAnthropicAccessToken(tokens.refreshToken);
      tokens = {
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken,
      };
    }

    const requestModels = async (
      accessToken: string,
    ): Promise<ModelOption[]> => {
      const response = await fetch(ANTHROPIC_MODELS_URL, {
        headers: {
          "anthropic-beta": ANTHROPIC_OAUTH_REQUIRED_BETA_HEADER,
          "anthropic-version": "2023-06-01",
          Authorization: `Bearer ${accessToken}`,
        },
        method: "GET",
      });

      if (!response.ok) {
        throw new Error(`Anthropic request failed (${response.status}).`);
      }

      const payload = (await response.json()) as {
        data?: Array<{ display_name?: string; id?: string }>;
      };
      return dedupeAndSort(
        (payload.data ?? []).flatMap((entry) => {
          const id = entry.id?.trim() ?? "";
          return id
            ? [createModelOption("anthropic", id, entry.display_name)]
            : [];
        }),
      );
    };

    const models = await requestModels(tokens.accessToken);

    if (models.length === 0) {
      return {
        error: "Anthropic returned no models.",
        models: [],
        source: "unavailable",
      };
    }

    return {
      models,
      oauth: {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt ?? Date.now() + 15 * 60 * 1000,
        refreshToken: tokens.refreshToken,
      },
      source: "api",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Anthropic models.",
      models: [],
      source: "unavailable",
    };
  }
};

const fetchAnthropicModels = async (
  authMode: AnthropicAuthMode,
  anthropicApiKey: string,
  oauthInput: AnthropicOAuthInput,
): Promise<ProviderModelResult> => {
  if (authMode === "claudeProMax") {
    return fetchAnthropicModelsWithOAuth(oauthInput);
  }

  if (!anthropicApiKey) {
    return {
      error: "Add an Anthropic API key to fetch the latest model list.",
      models: [],
      source: "unavailable",
    };
  }

  try {
    const response = await fetch(ANTHROPIC_MODELS_URL, {
      headers: {
        "anthropic-version": "2023-06-01",
        "x-api-key": anthropicApiKey,
      },
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Anthropic request failed (${response.status}).`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ display_name?: string; id?: string }>;
    };
    const models = dedupeAndSort(
      (payload.data ?? []).flatMap((entry) => {
        const id = entry.id?.trim() ?? "";
        return id
          ? [createModelOption("anthropic", id, entry.display_name)]
          : [];
      }),
    );

    if (models.length === 0) {
      return {
        error: "Anthropic returned no models.",
        models: [],
        source: "unavailable",
      };
    }

    return {
      models,
      source: "api",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Anthropic models.",
      models: [],
      source: "unavailable",
    };
  }
};

const fetchGeminiModels = async (
  geminiApiKey: string,
): Promise<ProviderModelResult> => {
  if (!geminiApiKey) {
    return {
      error: "Add a Gemini API key to fetch the latest model list.",
      models: [],
      source: "unavailable",
    };
  }

  try {
    const response = await fetch(GEMINI_OPENAI_MODELS_URL, {
      headers: {
        Authorization: `Bearer ${geminiApiKey}`,
        "Content-Type": "application/json",
      },
      method: "GET",
    });

    if (!response.ok) {
      throw new Error(`Gemini request failed (${response.status}).`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const modelIds = (payload.data ?? [])
      .flatMap((entry) => {
        const id = entry.id?.trim() ?? "";
        return id ? [id] : [];
      })
      .filter((id) => id.toLowerCase().startsWith("gemini"));

    const models = dedupeAndSort(
      modelIds.map((id) => createModelOption("gemini", id)),
    );

    if (models.length === 0) {
      return {
        error: "Gemini returned no models.",
        models: [],
        source: "unavailable",
      };
    }

    return {
      models,
      source: "api",
    };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Unable to fetch Gemini models.",
      models: [],
      source: "unavailable",
    };
  }
};

export async function POST(request: Request): Promise<Response> {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return new Response("Invalid JSON payload.", { status: 400 });
  }

  const parsed = requestBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return new Response(parsed.error.message, { status: 400 });
  }

  const openAiApiKey = parsed.data.openAiApiKey?.trim() ?? "";
  const anthropicApiKey = parsed.data.anthropicApiKey?.trim() ?? "";
  const geminiApiKey = parsed.data.geminiApiKey?.trim() ?? "";
  const openAiAuthMode = parsed.data.openAiAuthMode;
  const anthropicAuthMode = parsed.data.anthropicAuthMode;
  const anthropicOAuthInput: AnthropicOAuthInput = {
    accessToken: parsed.data.anthropicAccessToken?.trim() ?? "",
    expiresAt: parsed.data.anthropicAccessTokenExpiresAt ?? null,
    refreshToken: parsed.data.anthropicRefreshToken?.trim() ?? "",
  };

  const [openai, anthropic, gemini] = await Promise.all([
    fetchOpenAiModels(openAiAuthMode, openAiApiKey),
    fetchAnthropicModels(
      anthropicAuthMode,
      anthropicApiKey,
      anthropicOAuthInput,
    ),
    fetchGeminiModels(geminiApiKey),
  ]);

  return Response.json({
    anthropic,
    fetchedAt: new Date().toISOString(),
    gemini,
    openai,
  });
}
