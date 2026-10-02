// The window's catalog sync against a real host: a project opened on an SSH
// host, saved the way the store saves it, is in the host's catalog
// afterwards (and so survives a reload of the window).
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
    dataDirectory: mkdtempSync(path.join(os.tmpdir(), "dream-sync-host-")),
  });
  const port = await host.listen({ apiToken: TOKEN, port: 0 });
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await host?.close();
});

const client = () =>
  createApiClient(
    createHttpTransport((url, init) =>
      fetch(`${base}${url}`, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string>),
          "x-dream-api-token": TOKEN,
        },
      }),
    ),
  );

test("a project opened on a host reaches that host's catalog", async () => {
  const api = client();
  const sync = createCatalogSync({ api });
  sync.reset({ chats: [], closedProjects: [], projects: [] });

  const project: ProjectConfig = {
    ...createProjectConfig("/root/devops", DEFAULT_SETTINGS),
    hostId: "dev",
  };
  const draft = createChatConfig(project, { title: "New chat" });
  const live = {
    chats: [draft],
    closedProjects: [],
    projects: [{ ...project, ui: { ...project.ui, activeChatId: draft.id } }],
  };
  const encoded = encodePersistedState({
    ...live,
    messagesByChatId: {},
    settings: DEFAULT_SETTINGS,
  } as never);

  const result = await sync.push(
    live as never,
    {
      chats: encoded.chats,
      closedProjects: encoded.closedProjects,
      projects: encoded.projects,
    } as never,
  );
  expect(result).not.toBeNull();
  expect(result?.conflicts).toEqual([]);

  const catalog = await api.catalog({});
  expect(catalog.projects.map((item) => (item as { id: string }).id)).toContain(
    project.id,
  );
});
