// Two windows on one real host (say a PC's own window and a Mac paired with
// it): a chat one of them starts in a project both show reaches the other
// over the host socket's catalog channel, with its message count, which the
// other window's lists need to show it.
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createApiClient, createHttpTransport } from "@/lib/api-client";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import type { ProjectConfig } from "@/types/ide";
import { createHost } from "../../../../electron/host/index.js";
import {
  createChatConfig,
  encodePersistedState,
} from "../../../../electron/shared/persisted-state-codec.js";
import { createCatalogSync } from "./catalog-sync";

const TOKEN = "test-token";
let host: Awaited<ReturnType<typeof createHost>> | null = null;
let base = "";

beforeAll(async () => {
  host = createHost({
    dataDirectory: mkdtempSync(path.join(os.tmpdir(), "dream-two-clients-")),
  });
  const port = await host.listen({ apiToken: TOKEN, port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await host?.close();
});

/** One window's API client, with its own client id. */
const client = (clientId: string) =>
  createApiClient(
    createHttpTransport((url, init) =>
      fetch(`${base}${url}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          "x-dream-api-token": TOKEN,
          "x-dream-client-id": clientId,
        },
      }),
    ),
  );

/** Saves `live` (projects and chats) the way a window's catalog sync does. */
const push = (clientId: string, live: Record<string, unknown>) => {
  const sync = createCatalogSync({ api: client(clientId) });
  sync.reset({ chats: [], closedProjects: [], projects: [] });
  const encoded = encodePersistedState({
    ...live,
    closedProjects: [],
    messagesByChatId: {},
    settings: DEFAULT_SETTINGS,
  } as never);
  return sync.push(
    { ...live, closedProjects: [] } as never,
    {
      chats: encoded.chats,
      closedProjects: encoded.closedProjects,
      projects: encoded.projects,
    } as never,
  );
};

/** A window's host socket: every catalog event it is sent. */
const watch = async () => {
  const response = await fetch(`${base}/api/host-socket-ticket`, {
    body: "{}",
    headers: { "Content-Type": "application/json", "x-dream-api-token": TOKEN },
    method: "POST",
  });
  const { ticket } = (await response.json()) as { ticket: string };
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/api/host-socket?ticket=${ticket}`,
  );
  const events: Record<string, unknown>[] = [];
  socket.addEventListener("message", (message) => {
    const data = JSON.parse(String(message.data));
    if (data.channel === "catalog" && data.type === "event")
      events.push(data.event);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      channel: "host",
      type: "resume",
      cursors: { catalog: null, terminal: [] },
    }),
  );
  return { events, close: () => socket.close() };
};

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting.");
};

const message = (id: string, role: "user" | "assistant") => ({
  id,
  role,
  parts: [{ type: "text", text: id }],
});

test("a chat one window starts reaches the other with its message count", async () => {
  const project: ProjectConfig = createProjectConfig(
    path.join(os.tmpdir(), "shared-project"),
    DEFAULT_SETTINGS,
  );
  // A chat the PC already had (the catalog keeps a chat once it has messages).
  const first = {
    ...createChatConfig(project, { title: "On the PC" }),
    messageCount: 2,
  };
  await push("pc", { chats: [first], projects: [project] });
  const pc = await watch();

  // The Mac starts a chat: it reaches the host before its turn has written
  // anything, and the turn's messages are saved on the host afterwards.
  const mac = {
    ...createChatConfig(project, { title: "On the Mac" }),
    pinned: true,
  };
  await push("mac", { chats: [first, mac], projects: [project] });
  await client("host").saveCatalogTranscript({
    chatId: mac.id,
    messages: [message("question", "user"), message("answer", "assistant")],
  });

  await until(() =>
    pc.events.some(
      (event) => event.kind === "transcript" && event.chatId === mac.id,
    ),
  );
  const created = pc.events.find(
    (event) =>
      event.kind === "changes" &&
      (event.chats as { id: string }[]).some((chat) => chat.id === mac.id),
  );
  expect(created?.origin).toBe("mac");
  const saved = pc.events.find(
    (event) => event.kind === "transcript" && event.chatId === mac.id,
  );
  expect(saved?.messageCount).toBe(2);
  pc.close();
});
