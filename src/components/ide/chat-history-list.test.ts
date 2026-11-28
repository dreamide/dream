import { NextIntlClientProvider } from "next-intl";
import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import en from "@/i18n/messages/en.json";
import {
  createChatConfig,
  createProjectConfig,
  DEFAULT_SETTINGS,
} from "@/lib/ide-defaults";
import type { ChatConfig } from "@/types/ide";
import { ChatHistoryList } from "./chat-history-list";

const project = createProjectConfig("/history", DEFAULT_SETTINGS);
const row = (id: string, delegatedByChatId?: string): ChatConfig => ({
  ...createChatConfig(project, { title: id }),
  id,
  delegatedByChatId,
  messageCount: 1,
});
const chats = [
  row("grandchild", "review"),
  { ...row("parent"), messageCount: 0 },
  row("review", "parent"),
  { ...row("queued", "parent"), messageCount: 0 },
  row("orphan", "archived parent"),
  row("Task: ordinary title"),
  { ...row("empty draft"), messageCount: 0 },
];

function history(query = "", activeChatId: string | null = null) {
  const html = renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      {
        locale: "en",
        timeZone: "UTC",
        messages: en,
      } as ComponentProps<typeof NextIntlClientProvider>,
      createElement(ChatHistoryList, {
        chats,
        query,
        activeChatId,
        emptyLabel: "No matching chats",
        renderChat: (chat, { disclosure, reserveDisclosureSpace }) =>
          createElement(
            "span",
            {
              "data-chat": chat.id,
              "data-disclosure-space": reserveDisclosureSpace,
            },
            disclosure,
            chat.title,
          ),
      }),
    ),
  );
  return {
    html,
    rows: [...html.matchAll(/data-chat="([^"]+)"/g)].map((match) => match[1]),
  };
}

test("groups start collapsed, with ungrouped and orphaned chats still reachable", () => {
  const { rows, html } = history();
  expect(rows).toEqual(["parent", "orphan", "Task: ordinary title"]);
  expect(html).toContain('aria-expanded="false"');
});

test("search reveals the parent path, and a matching parent includes its queued tasks", () => {
  expect(history(" GRANDCHILD ").rows).toEqual([
    "parent",
    "review",
    "grandchild",
  ]);
  expect(history("parent").rows).toEqual([
    "parent",
    "review",
    "grandchild",
    "queued",
  ]);
  expect(history("missing").html).toContain("No matching chats");
});

test("opening history on an active subagent reveals its ancestors", () => {
  expect(history("", "grandchild").rows).toEqual([
    "parent",
    "review",
    "grandchild",
    "queued",
    "orphan",
    "Task: ordinary title",
  ]);
});

test("nested chats only leave room for a chevron when they have one", () => {
  const { html } = history("", "grandchild");
  expect(html).toContain('data-chat="orphan" data-disclosure-space="true"');
  expect(html).toContain('data-chat="review" data-disclosure-space="true"');
  expect(html).toContain(
    'data-chat="grandchild" data-disclosure-space="false"',
  );
  expect(html).toContain('data-chat="queued" data-disclosure-space="false"');
});
