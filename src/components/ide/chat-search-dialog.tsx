import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import {
  apiClient,
  type CatalogSearchResult,
  isAbortError,
} from "@/lib/api-client";
import { LOCAL_HOST_ID } from "@/lib/host-routing";
import { formatLastActiveTime } from "./activity-time";
import {
  buildChatSearchRows,
  CHAT_SEARCH_MAX_ROWS,
  CHAT_SEARCH_MIN_TRANSCRIPT_QUERY,
  type ChatSearchRow,
  useChatSearchStore,
} from "./chat-search";
import { useIdeStore } from "./ide-store";

const SEARCH_DEBOUNCE_MS = 200;

interface TranscriptSearch {
  /** The query these results answer. */
  query: string;
  results: CatalogSearchResult[];
  truncated: boolean;
  /** A host could not be searched. */
  failed: boolean;
}

const NO_SEARCH: TranscriptSearch = {
  failed: false,
  query: "",
  results: [],
  truncated: false,
};

/** Searches the transcripts on the local host and every loaded SSH host. */
const useTranscriptSearch = (query: string, enabled: boolean) => {
  const [search, setSearch] = useState(NO_SEARCH);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed.length < CHAT_SEARCH_MIN_TRANSCRIPT_QUERY) {
      setSearch(NO_SEARCH);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(async () => {
      const hosts = useIdeStore.getState().hosts;
      const hostIds = [
        LOCAL_HOST_ID,
        ...Object.keys(hosts).filter(
          (hostId) =>
            hostId !== LOCAL_HOST_ID &&
            hosts[hostId].state === "connected" &&
            hosts[hostId].loaded,
        ),
      ];
      const answers = await Promise.allSettled(
        hostIds.map((hostId) =>
          apiClient.catalogSearch(
            { limit: CHAT_SEARCH_MAX_ROWS, query: trimmed },
            { hostId, signal: controller.signal },
          ),
        ),
      );
      if (controller.signal.aborted) return;

      const next: TranscriptSearch = { ...NO_SEARCH, query: trimmed };
      const results: CatalogSearchResult[] = [];
      for (const answer of answers) {
        if (answer.status === "fulfilled") {
          results.push(...answer.value.results);
          next.truncated ||= answer.value.truncated;
        } else if (!isAbortError(answer.reason)) {
          next.failed = true;
        }
      }
      setSearch({ ...next, results });
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, query]);

  return { search, searching };
};

const openChat = ({ chat, project }: ChatSearchRow) => {
  const state = useIdeStore.getState();
  if (chat.deletedAt !== null) {
    state.restoreChats([chat.id]);
  }
  if (!state.projects.some((item) => item.id === project.id)) {
    // A closed project reopens with its chats.
    state.addProject(project.path, { activate: true, hostId: project.hostId });
  }
  state.setSettingsOpen(false);
  state.setActiveProjectId(project.id);
  state.setActiveChatId(project.id, chat.id);
};

export const ChatSearchDialog = () => {
  const locale = useLocale();
  const t = useTranslations("workspace");
  const commonT = useTranslations("common");
  const open = useChatSearchStore((s) => s.open);
  const setOpen = useChatSearchStore((s) => s.setOpen);
  const chats = useIdeStore((s) => s.chats);
  const openProjects = useIdeStore((s) => s.projects);
  const closedProjects = useIdeStore((s) => s.closedProjects);
  const [query, setQuery] = useState("");
  const { search, searching } = useTranscriptSearch(query, open);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  // Ctrl/Cmd+Shift+F, from anywhere in the window.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() === "f" &&
        event.shiftKey &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setOpen]);

  const relativeTimeFormatter = useMemo(
    () =>
      new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }),
    [locale],
  );

  const rows = useMemo(
    () =>
      open
        ? buildChatSearchRows({
            chats,
            projects: [...openProjects, ...closedProjects],
            query,
            transcriptResults: search.results,
          })
        : [],
    [chats, closedProjects, open, openProjects, query, search.results],
  );

  const trimmedQuery = query.trim();
  // Transcript results for an older query are still listed while the next
  // search runs; "no results" waits for the search that answers this query.
  const settled =
    !searching &&
    (trimmedQuery.length < CHAT_SEARCH_MIN_TRANSCRIPT_QUERY ||
      search.query === trimmedQuery);

  return (
    <CommandDialog
      className="sm:max-w-2xl"
      description={t("searchChatsPlaceholder")}
      onOpenChange={setOpen}
      open={open}
      title={t("searchChats")}
    >
      <Command shouldFilter={false}>
        <div className="relative">
          <CommandInput
            onValueChange={setQuery}
            placeholder={t("searchChatsPlaceholder")}
            value={query}
          />
          {searching ? (
            <Spinner className="-translate-y-1/2 absolute top-1/2 right-3 mt-0.5 size-3.5" />
          ) : null}
        </div>
        <CommandList className="max-h-[60vh] p-1">
          {rows.map((row) => (
            <CommandItem
              className="flex-col items-stretch gap-0.5 py-2 [&>svg:last-child]:hidden"
              key={row.chat.id}
              onSelect={() => {
                openChat(row);
                setOpen(false);
              }}
              value={row.chat.id}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate font-medium">
                  {row.chat.title}
                </span>
                {row.chat.deletedAt !== null ? (
                  <Badge className="shrink-0" variant="secondary">
                    {commonT("archived")}
                  </Badge>
                ) : null}
                <span className="ml-auto shrink-0 text-muted-foreground text-xs">
                  {row.project.name}
                  {" · "}
                  {formatLastActiveTime(
                    row.chat.updatedAt || row.chat.createdAt,
                    relativeTimeFormatter,
                  )}
                </span>
              </div>
              {row.snippet ? (
                <p className="line-clamp-2 text-muted-foreground text-xs leading-5">
                  {row.snippet.before}
                  <mark className="rounded-xs bg-amber-500/30 text-foreground">
                    {row.snippet.match}
                  </mark>
                  {row.snippet.after}
                  {row.moreMatches > 0 ? (
                    <span className="ml-2 text-muted-foreground/70">
                      +{row.moreMatches}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </CommandItem>
          ))}
          {rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-muted-foreground text-sm">
              {trimmedQuery && settled
                ? t("searchChatsEmpty")
                : trimmedQuery
                  ? null
                  : t("searchChatsHint")}
            </p>
          ) : null}
          {settled && (search.truncated || search.failed) ? (
            <p className="px-3 py-2 text-center text-muted-foreground text-xs">
              {search.failed
                ? t("searchChatsFailed")
                : t("searchChatsTruncated")}
            </p>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
};
