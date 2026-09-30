import { Check, Copy } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import {
  memo,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { apiClient, getApiErrorMessage, isAbortError } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import type { ProjectGitLogCommit, ProjectGitLogResponse } from "@/types/ide";
import { formatLastActiveTime } from "../activity-time";
import { useIdeStore } from "../ide-store";
import {
  GIT_LOG_PANEL_MAX_WIDTH_PX,
  GIT_LOG_PANEL_MIN_WIDTH_PX,
  SLIDING_PANEL_TRANSITION,
  WORKSPACE_SIDE_NAV_WIDTH_PX,
} from "./constants";
import { WorkspaceSlidingPanel } from "./sliding-panel";

const GIT_LOG_PAGE_SIZE = 100;
const COPIED_FEEDBACK_MS = 1500;

const fetchGitLog = async (
  projectPath: string,
  skip: number,
  signal: AbortSignal,
): Promise<ProjectGitLogResponse> => {
  return apiClient.gitLog(
    { limit: GIT_LOG_PAGE_SIZE, projectPath, skip },
    { signal },
  );
};

// An empty message falls back to the translated generic error when rendered.
const getErrorMessage = (error: unknown) => getApiErrorMessage(error, "");

const matchesCommit = (commit: ProjectGitLogCommit, query: string) =>
  commit.subject.toLowerCase().includes(query) ||
  commit.authorName.toLowerCase().includes(query) ||
  commit.authorEmail.toLowerCase().includes(query) ||
  commit.hash.toLowerCase().startsWith(query) ||
  commit.refs.some((ref) => ref.toLowerCase().includes(query));

const GitLogRow = ({
  commit,
  relativeTimeFormatter,
}: {
  commit: ProjectGitLogCommit;
  relativeTimeFormatter: Intl.RelativeTimeFormat;
}) => {
  const gitT = useTranslations("git");
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(commit.hash);
    } catch {
      return;
    }

    setCopied(true);
    if (copiedTimerRef.current !== null) {
      clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = setTimeout(() => {
      copiedTimerRef.current = null;
      setCopied(false);
    }, COPIED_FEEDBACK_MS);
  }, [commit.hash]);

  const authoredAt = Date.parse(commit.authorDate);
  const tooltip = [
    commit.subject,
    `${commit.shortHash} · ${commit.authorName}${
      commit.authorEmail ? ` <${commit.authorEmail}>` : ""
    }`,
    Number.isNaN(authoredAt) ? "" : new Date(authoredAt).toLocaleString(),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="group relative min-w-0 rounded-md border border-transparent hover:bg-surface-50 dark:hover:bg-surface-900">
      <div className="min-w-0 px-3 py-2" title={tooltip}>
        <div className="flex min-w-0 items-baseline gap-3">
          <p className="min-w-0 flex-1 truncate text-sm leading-5">
            {commit.subject || gitT("noSubject")}
          </p>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground text-xs leading-5 group-hover:opacity-0 group-focus-within:opacity-0">
            {formatLastActiveTime(commit.authorDate, relativeTimeFormatter)}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5 pr-8 text-muted-foreground text-xs leading-5">
          <span className="shrink-0 font-mono">{commit.shortHash}</span>
          {commit.refs.map((ref) => (
            <span
              className="max-w-32 shrink-0 truncate rounded border border-border px-1 font-medium text-[11px] leading-4 text-foreground/80"
              key={ref}
            >
              {ref.replace(/^tag: /, "")}
            </span>
          ))}
          <span className="min-w-0 truncate">{commit.authorName}</span>
        </div>
      </div>
      <div className="-translate-y-1/2 absolute top-1/2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
        <Button
          aria-label={gitT("copyCommitHash")}
          className="size-7 rounded-md p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={handleCopy}
          size="icon-sm"
          title={gitT("copyCommitHash")}
          type="button"
          variant="ghost"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>
    </div>
  );
};

const GitLogList = ({
  open,
  projectId,
  projectPath,
}: {
  open: boolean;
  projectId: string;
  projectPath: string;
}) => {
  const locale = useLocale();
  const gitT = useTranslations("git");
  const panelsT = useTranslations("panels");
  const pullRequestsT = useTranslations("pullRequests");
  const relativeTimeFormatter = useMemo(
    () =>
      new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" }),
    [locale],
  );
  const gitRefreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[projectId] ?? 0,
  );
  const [commits, setCommits] = useState<ProjectGitLogCommit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // Bumped by every first-page load so a slower "load more" cannot append
  // commits from a history that has since been reloaded.
  const generationRef = useRef(0);
  const loadMoreAbortRef = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: gitRefreshKey reloads the log after commits, pushes and branch switches.
  useEffect(() => {
    if (!open) {
      return;
    }

    const abortController = new AbortController();
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    loadMoreAbortRef.current?.abort();
    setLoading(true);
    setLoadingMore(false);
    setError(null);

    fetchGitLog(projectPath, 0, abortController.signal)
      .then((payload) => {
        if (generationRef.current !== generation) {
          return;
        }
        setCommits(payload.commits);
        setHasMore(payload.hasMore);
      })
      .catch((loadError: unknown) => {
        if (isAbortError(loadError) || generationRef.current !== generation) {
          return;
        }
        setCommits([]);
        setHasMore(false);
        setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (generationRef.current === generation) {
          setLoading(false);
        }
      });

    return () => abortController.abort();
  }, [gitRefreshKey, open, projectPath]);

  useEffect(() => () => loadMoreAbortRef.current?.abort(), []);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasMore) {
      return;
    }

    const abortController = new AbortController();
    const generation = generationRef.current;
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = abortController;
    setLoadingMore(true);

    fetchGitLog(projectPath, commits.length, abortController.signal)
      .then((payload) => {
        if (generationRef.current !== generation) {
          return;
        }
        setCommits((current) => {
          const seen = new Set(current.map((commit) => commit.hash));
          return [
            ...current,
            ...payload.commits.filter((commit) => !seen.has(commit.hash)),
          ];
        });
        setHasMore(payload.hasMore);
      })
      .catch((loadError: unknown) => {
        if (isAbortError(loadError) || generationRef.current !== generation) {
          return;
        }
        setError(getErrorMessage(loadError));
      })
      .finally(() => {
        if (loadMoreAbortRef.current === abortController) {
          loadMoreAbortRef.current = null;
          setLoadingMore(false);
        }
      });
  }, [commits.length, hasMore, loadingMore, projectPath]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredCommits = useMemo(
    () =>
      normalizedQuery
        ? commits.filter((commit) => matchesCommit(commit, normalizedQuery))
        : commits,
    [commits, normalizedQuery],
  );

  const errorMessage = error === null ? null : error || gitT("unableToLoadLog");
  let emptyMessage: string | null = null;
  if (!loading && filteredCommits.length === 0) {
    emptyMessage =
      errorMessage ??
      (normalizedQuery ? gitT("noMatchingCommits") : gitT("noCommits"));
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-surface-300 bg-background shadow-md dark:border-surface-700">
      <div className="px-3 py-3">
        <p className="font-medium text-sm">{gitT("history")}</p>
        <SearchInput
          className="mt-2"
          clearLabel={panelsT("clearSearch")}
          onValueChange={setSearchQuery}
          placeholder={gitT("searchCommits")}
          value={searchQuery}
        />
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-2 pb-3">
          {loading && commits.length === 0 ? (
            <div className="flex min-h-32 items-center justify-center p-4">
              <Spinner className="size-4 text-muted-foreground" />
            </div>
          ) : emptyMessage ? (
            <div
              className={cn(
                "flex min-h-32 items-center justify-center p-4 text-center text-sm",
                errorMessage ? "text-destructive" : "text-muted-foreground",
              )}
            >
              <p className="min-w-0 break-words">{emptyMessage}</p>
            </div>
          ) : (
            filteredCommits.map((commit) => (
              <GitLogRow
                commit={commit}
                key={commit.hash}
                relativeTimeFormatter={relativeTimeFormatter}
              />
            ))
          )}
          {hasMore && !loading && !normalizedQuery ? (
            <div className="flex justify-center pt-1">
              <Button
                disabled={loadingMore}
                onClick={handleLoadMore}
                size="sm"
                type="button"
                variant="ghost"
              >
                {loadingMore ? <Spinner className="size-3.5" /> : null}
                {pullRequestsT("loadMore")}
              </Button>
            </div>
          ) : null}
          {errorMessage && commits.length > 0 ? (
            <p className="px-2 text-destructive text-sm">{errorMessage}</p>
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
};

export interface WorkspaceGitLogPanelProps {
  active: boolean;
  onClose: () => void;
  onResizeEnd: (width: number) => void;
  open: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  projectId: string;
  projectPath: string;
  width: number;
}

const WorkspaceGitLogPanelImpl = ({
  active,
  onClose,
  onResizeEnd,
  open,
  panelRef,
  projectId,
  projectPath,
  width,
}: WorkspaceGitLogPanelProps) => {
  const widthRef = useRef(width);

  return (
    <WorkspaceSlidingPanel
      className="z-30"
      contentClassName="py-2"
      contentMinWidth={GIT_LOG_PANEL_MIN_WIDTH_PX}
      maxWidth={GIT_LOG_PANEL_MAX_WIDTH_PX}
      minWidth={GIT_LOG_PANEL_MIN_WIDTH_PX}
      onHandleDoubleClick={onClose}
      onResizeEnd={onResizeEnd}
      open={open}
      reserveSpace={false}
      side="right"
      slotRef={panelRef}
      style={{ right: WORKSPACE_SIDE_NAV_WIDTH_PX }}
      transition={SLIDING_PANEL_TRANSITION}
      width={width}
      widthRef={widthRef}
    >
      {active ? (
        <GitLogList
          open={open}
          projectId={projectId}
          projectPath={projectPath}
        />
      ) : null}
    </WorkspaceSlidingPanel>
  );
};

export const WorkspaceGitLogPanel = memo(WorkspaceGitLogPanelImpl);
WorkspaceGitLogPanel.displayName = "WorkspaceGitLogPanel";
