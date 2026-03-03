import { z } from "zod";
import { readCodexCredential } from "@/lib/codex-auth";
import type { ProviderAuthMode } from "@/types/ide";

export const runtime = "nodejs";

const requestBodySchema = z.object({
  anthropicApiKey: z.string().optional(),
  openAiApiKey: z.string().optional(),
  openAiAuthMode: z.enum(["apiKey", "codex"]).default("apiKey"),
});

type ModelSource = "api" | "unavailable";

interface ProviderModelResult {
  models: string[];
  source: ModelSource;
  error?: string;
}

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const OPENAI_CODEX_CHATGPT_MODELS_URL =
  "https://chatgpt.com/backend-api/codex/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const CODEX_CLIENT_VERSION = "1.0.0";

const dedupeAndSort = (models: string[]): string[] => {
  return Array.from(
    new Set(models.map((model) => model.trim()).filter(Boolean)),
  )
    .sort((a, b) => a.localeCompare(b))
    .reverse();
};

const isOpenAiChatModel = (model: string): boolean => {
  return model.startsWith("gpt-") || /^o\d/.test(model);
};

const fetchOpenAiModelsWithApiKey = async (
  apiKey: string,
): Promise<string[]> => {
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

  const modelIds = (payload.data ?? [])
    .map((entry) => entry.id?.trim() ?? "")
    .filter(Boolean);
  const chatModels = modelIds.filter((model) => isOpenAiChatModel(model));

  return dedupeAndSort(chatModels.length > 0 ? chatModels : modelIds);
};

const fetchOpenAiModelsWithCodexChatgpt = async (
  accessToken: string,
): Promise<string[]> => {
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

  const modelIds = (payload.models ?? [])
    .map((entry) => entry.slug?.trim() ?? entry.display_name?.trim() ?? "")
    .filter(Boolean);

  return dedupeAndSort(modelIds);
};

const fetchOpenAiModels = async (
  authMode: ProviderAuthMode,
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

const fetchAnthropicModels = async (
  anthropicApiKey: string,
): Promise<ProviderModelResult> => {
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
      data?: Array<{ id?: string }>;
    };
    const modelIds = (payload.data ?? [])
      .map((entry) => entry.id?.trim() ?? "")
      .filter(Boolean);
    const models = dedupeAndSort(modelIds);

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
  const openAiAuthMode = parsed.data.openAiAuthMode;

  const [openai, anthropic] = await Promise.all([
    fetchOpenAiModels(openAiAuthMode, openAiApiKey),
    fetchAnthropicModels(anthropicApiKey),
  ]);

  return Response.json({
    anthropic,
    fetchedAt: new Date().toISOString(),
    openai,
  });
}
