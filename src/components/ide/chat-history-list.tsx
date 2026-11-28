import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ChatConfig } from "@/types/ide";

interface HistoryNode {
  chat: ChatConfig;
  children: HistoryNode[];
  hasActiveChild: boolean;
}

/** The catalog supplies the parent. A task whose parent is outside this history stays reachable. */
function buildChatHistory(
  chats: ChatConfig[],
  query: string,
  activeChatId: string | null,
) {
  const nodes = new Map<string, HistoryNode>();
  for (const chat of chats)
    nodes.set(chat.id, { chat, children: [], hasActiveChild: false });
  const roots: HistoryNode[] = [];
  for (const node of nodes.values()) {
    const parent =
      node.chat.delegatedByChatId && nodes.get(node.chat.delegatedByChatId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const include = (node: HistoryNode, ancestorMatches: boolean): boolean => {
    const { chat } = node;
    const matches = ancestorMatches || chat.title.toLowerCase().includes(query);
    node.children = node.children.filter((child) => include(child, matches));
    node.hasActiveChild = node.children.some(
      (child) => child.chat.id === activeChatId || child.hasActiveChild,
    );
    return (
      node.children.length > 0 ||
      (matches &&
        (chat.messageCount > 0 || chat.pinned || !!chat.delegatedByChatId))
    );
  };
  return roots.filter((node) => include(node, false));
}

export function ChatHistoryList({
  chats,
  query,
  activeChatId,
  emptyLabel,
  renderChat,
}: {
  chats: ChatConfig[];
  query: string;
  activeChatId: string | null;
  emptyLabel: string;
  renderChat: (
    chat: ChatConfig,
    options: { disclosure: ReactNode; reserveDisclosureSpace: boolean },
  ) => ReactNode;
}) {
  const t = useTranslations("projects");
  const search = query.trim().toLowerCase();
  const roots = useMemo(
    () => buildChatHistory(chats, search, activeChatId),
    [chats, search, activeChatId],
  );
  const hasGroups = roots.some((node) => node.children.length > 0);
  const [expanded, setExpanded] = useState(
    new Map<string, { open: boolean; activeChatId: string | null }>(),
  );
  const [searchGroups, setSearchGroups] = useState<{
    search: string;
    expanded: Map<string, boolean>;
  }>();
  const searchOverrides =
    searchGroups?.search === search ? searchGroups.expanded : undefined;

  const renderNode = (
    { chat, children: tasks, hasActiveChild }: HistoryNode,
    nested: boolean,
  ) => {
    const choice = expanded.get(chat.id);
    const open = search
      ? (searchOverrides?.get(chat.id) ?? true)
      : choice?.open ||
        (hasActiveChild && choice?.activeChatId !== activeChatId);
    const label = t("subagentChatsFor", { name: chat.title });
    const disclosure = tasks.length > 0 && (
      <Button
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="text-muted-foreground"
        onClick={() => {
          if (search)
            setSearchGroups({
              search,
              expanded: new Map(searchOverrides).set(chat.id, !open),
            });
          else
            setExpanded(
              new Map(expanded).set(chat.id, {
                open: !open,
                activeChatId,
              }),
            );
        }}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <ChevronRight
          aria-hidden="true"
          className={open ? "size-4 rotate-90" : "size-4"}
        />
      </Button>
    );
    return (
      <li key={chat.id} className="min-w-0">
        {renderChat(chat, {
          disclosure,
          reserveDisclosureSpace: tasks.length > 0 || (!nested && hasGroups),
        })}
        {tasks.length > 0 && open && (
          <ul className="ms-4 mt-1 space-y-1 border-s border-border ps-2">
            {tasks.map((task) => renderNode(task, true))}
          </ul>
        )}
      </li>
    );
  };

  return roots.length ? (
    <ul className="space-y-1">
      {roots.map((node) => renderNode(node, false))}
    </ul>
  ) : (
    <p className="flex min-h-32 items-center justify-center p-4 text-center text-muted-foreground text-sm">
      {emptyLabel}
    </p>
  );
}
