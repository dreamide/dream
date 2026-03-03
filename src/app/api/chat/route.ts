import { promises as fs } from "node:fs";
import path from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import { readCodexCredential } from "@/lib/codex-auth";

export const runtime = "nodejs";

const requestBodySchema = z.object({
  authMode: z.enum(["apiKey", "codex"]).default("apiKey"),
  credential: z.string().optional(),
  messages: z.array(z.unknown()),
  model: z.string().min(1),
  projectPath: z.string().min(1),
  provider: z.enum(["openai", "anthropic"]),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
});

const BLOCKED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

const SYSTEM_PROMPT = `You are an expert coding copilot embedded in a desktop IDE.

Your primary responsibility is to safely edit files inside the active project.
Use the available tools to inspect files before proposing changes.
Always reference concrete files and exact updates.
When writing files, prefer complete and correct output over partial snippets.
Never attempt to access files outside the active project root.`;

const OPENAI_CODEX_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex";

const normalizePath = (value: string): string => value.replace(/\\/g, "/");

const resolveProjectPath = (projectRoot: string, filePath: string): string => {
  const root = path.resolve(projectRoot);
  const fullPath = path.resolve(root, filePath);

  if (fullPath === root) {
    return fullPath;
  }

  if (!fullPath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Path is outside of the project root.");
  }

  return fullPath;
};

const walkFiles = async (
  root: string,
  current: string,
  maxResults: number,
  output: string[],
): Promise<void> => {
  if (output.length >= maxResults) {
    return;
  }

  const entries = await fs.readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (output.length >= maxResults) {
      return;
    }

    if (entry.name.startsWith(".") && entry.name !== ".env") {
      continue;
    }

    if (entry.isDirectory() && BLOCKED_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const absolute = path.join(current, entry.name);
    const relative = normalizePath(path.relative(root, absolute));

    if (entry.isDirectory()) {
      await walkFiles(root, absolute, maxResults, output);
      continue;
    }

    output.push(relative);
  }
};

const listProjectFiles = async (
  projectRoot: string,
  directory: string,
  maxResults: number,
): Promise<string[]> => {
  const targetDirectory = resolveProjectPath(projectRoot, directory);
  const stats = await fs.stat(targetDirectory);

  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${directory}`);
  }

  const files: string[] = [];
  await walkFiles(projectRoot, targetDirectory, maxResults, files);

  return files;
};

const searchInProjectFiles = async (
  projectRoot: string,
  query: string,
  maxResults: number,
): Promise<Array<{ file: string; line: number; text: string }>> => {
  const files = await listProjectFiles(projectRoot, ".", 250);
  const matches: Array<{ file: string; line: number; text: string }> = [];

  for (const relativePath of files) {
    if (matches.length >= maxResults) {
      break;
    }

    const absolutePath = resolveProjectPath(projectRoot, relativePath);

    let content = "";
    try {
      content = await fs.readFile(absolutePath, "utf8");
    } catch {
      continue;
    }

    if (!content.includes(query)) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.includes(query)) {
        continue;
      }

      matches.push({
        file: relativePath,
        line: index + 1,
        text: line.trim(),
      });

      if (matches.length >= maxResults) {
        break;
      }
    }
  }

  return matches;
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

  const { authMode, model, projectPath, provider, reasoningEffort } =
    parsed.data;
  let credential = parsed.data.credential?.trim() ?? "";
  const messages = parsed.data.messages as UIMessage[];

  try {
    const projectStats = await fs.stat(projectPath);
    if (!projectStats.isDirectory()) {
      return new Response("projectPath must point to a directory.", {
        status: 400,
      });
    }
  } catch {
    return new Response("Project path does not exist.", { status: 400 });
  }

  let useChatgptCodexEndpoint = false;

  if (provider === "openai" && authMode === "codex") {
    const codexCredential = await readCodexCredential();

    if (!codexCredential.credential) {
      return new Response(
        "Codex login not found. Run `codex login` and try again.",
        {
          status: 401,
        },
      );
    }

    credential = codexCredential.credential;
    useChatgptCodexEndpoint = codexCredential.source === "chatgpt";
  }

  if (!credential) {
    return new Response("Missing provider credential.", { status: 400 });
  }

  const providerFactory =
    provider === "anthropic"
      ? createAnthropic({ apiKey: credential })
      : createOpenAI({
          apiKey: credential,
          ...(useChatgptCodexEndpoint
            ? { baseURL: OPENAI_CODEX_CHATGPT_BASE_URL }
            : {}),
        });

  const openAiProviderOptions =
    provider === "openai"
      ? {
          ...(useChatgptCodexEndpoint
            ? {
                instructions: SYSTEM_PROMPT,
                store: false,
              }
            : {}),
          reasoningEffort,
        }
      : undefined;

  const textResult = streamText({
    messages: await convertToModelMessages(messages),
    model: providerFactory(model),
    ...(openAiProviderOptions
      ? { providerOptions: { openai: openAiProviderOptions } }
      : {}),
    stopWhen: stepCountIs(8),
    system:
      provider === "openai" && useChatgptCodexEndpoint
        ? undefined
        : SYSTEM_PROMPT,
    temperature: 0.2,
    tools: {
      listFiles: tool({
        description:
          "List project files recursively. Use this before reading or editing unfamiliar areas.",
        inputSchema: z.object({
          directory: z.string().default("."),
          maxResults: z.number().int().min(1).max(400).default(200),
        }),
        execute: async ({ directory, maxResults }) => {
          const files = await listProjectFiles(
            projectPath,
            directory,
            maxResults,
          );
          return {
            count: files.length,
            files,
          };
        },
      }),
      readFile: tool({
        description:
          "Read a UTF-8 file from the project. Optionally scope output by line range.",
        inputSchema: z.object({
          endLine: z.number().int().min(1).optional(),
          filePath: z.string().min(1),
          startLine: z.number().int().min(1).optional(),
        }),
        execute: async ({ endLine, filePath, startLine }) => {
          const absolutePath = resolveProjectPath(projectPath, filePath);
          const fullText = await fs.readFile(absolutePath, "utf8");

          if (!startLine && !endLine) {
            return {
              filePath,
              content: fullText,
            };
          }

          const lines = fullText.split(/\r?\n/);
          const safeStart = Math.max(1, startLine ?? 1);
          const safeEnd = Math.min(lines.length, endLine ?? lines.length);

          if (safeStart > safeEnd) {
            throw new Error("startLine cannot be greater than endLine.");
          }

          const content = lines.slice(safeStart - 1, safeEnd).join("\n");

          return {
            filePath,
            content,
            endLine: safeEnd,
            startLine: safeStart,
          };
        },
      }),
      writeFile: tool({
        description:
          "Write UTF-8 content to a file in the project. Creates parent directories as needed.",
        inputSchema: z.object({
          content: z.string(),
          filePath: z.string().min(1),
          mode: z.enum(["overwrite", "append"]).default("overwrite"),
        }),
        execute: async ({ content, filePath, mode }) => {
          const absolutePath = resolveProjectPath(projectPath, filePath);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });

          if (mode === "append") {
            await fs.appendFile(absolutePath, content, "utf8");
          } else {
            await fs.writeFile(absolutePath, content, "utf8");
          }

          return {
            bytesWritten: Buffer.byteLength(content, "utf8"),
            filePath,
            mode,
            status: "ok",
          };
        },
      }),
      searchInFiles: tool({
        description:
          "Search text across project files and return matching file/line snippets.",
        inputSchema: z.object({
          maxResults: z.number().int().min(1).max(100).default(25),
          query: z.string().min(1),
        }),
        execute: async ({ maxResults, query }) => {
          const matches = await searchInProjectFiles(
            projectPath,
            query,
            maxResults,
          );
          return {
            count: matches.length,
            matches,
          };
        },
      }),
    },
  });

  return textResult.toUIMessageStreamResponse();
}
