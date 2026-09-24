import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleX,
  Clock3,
  Columns2,
  Ellipsis,
  ExternalLink,
  FileCode2,
  GitPullRequest,
  RefreshCw,
  Rows3,
  TextWrap,
  Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown } from "streamdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";
import { Textarea } from "@/components/ui/textarea";
import { useProjectGitStatus } from "@/hooks/use-project-git-status";
import { getDefaultGitGenerationModelSelection } from "@/lib/ide-defaults";
import { cn } from "@/lib/utils";
import type { ProjectConfig, ProjectGitStatusEntry } from "@/types/ide";
import type { DiffViewMode } from "../changes";
import { FileChangeHeader } from "../changes/file-change-header";
import { IdeDiffViewer } from "../diff-viewer";
import { CreatePrDialog } from "../git-actions/create-pr-dialog";
import { useIdeStore } from "../ide-store";
import { RightPanelHeaderIconButton } from "../right-panel-header-icon-button";
import {
  type Page,
  type PrComment,
  type PrFile,
  type PullRequestDetail,
  type PullRequestSummary,
  prRequest,
  usePrDraft,
  usePullRequestContext,
} from "./api";

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to complete the request.";
const draftKey = (repository: string, number: number, kind: string) =>
  `dream:code-pr:${repository}:${number}:${kind}`;

function PullRequestStatus({ pr }: { pr: PullRequestSummary }) {
  const state = pr.state === "open" && pr.draft ? "draft" : pr.state;
  const styles = {
    open: "border-success-border bg-success-surface text-success-foreground",
    merged:
      "border-purple-500/25 bg-purple-500/10 text-purple-700 dark:text-purple-300",
    closed: "border-destructive-border bg-destructive-surface text-destructive",
    draft: "border-border bg-muted text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={styles[state]}>
      <GitPullRequest className="size-3" />
      {state[0].toUpperCase() + state.slice(1)}
    </Badge>
  );
}

function checkSummary(checks: PullRequestDetail["checks"]) {
  if (checks === null)
    return {
      label: "Checks unavailable",
      className: "text-muted-foreground",
      icon: Clock3,
    };
  if (!checks.length)
    return {
      label: "No checks",
      className: "text-muted-foreground",
      icon: CheckCircle2,
    };
  const states = checks.map((check) =>
    (
      check.conclusion ||
      check.state ||
      check.status ||
      "PENDING"
    ).toUpperCase(),
  );
  if (
    states.some((state) =>
      [
        "FAILURE",
        "ERROR",
        "TIMED_OUT",
        "CANCELLED",
        "ACTION_REQUIRED",
        "STARTUP_FAILURE",
        "STALE",
      ].includes(state),
    )
  )
    return {
      label: checks.length === 1 ? "Failed" : "Checks need attention",
      className: "text-destructive",
      icon: CircleX,
    };
  if (
    states.some((state) => !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state))
  )
    return {
      label: "Checks pending",
      className: "text-amber-700 dark:text-amber-300",
      icon: Clock3,
    };
  return {
    label: checks.length === 1 ? "Passed" : "All checks passed",
    className: "text-success-foreground",
    icon: CheckCircle2,
  };
}

function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-relaxed">
      <Streamdown mode="static">{children || "—"}</Streamdown>
    </div>
  );
}

function Composer({
  storageKey,
  initial = "",
  initialVersion,
  label,
  busy,
  onSubmit,
  onCancel,
  allowEmpty = false,
}: {
  storageKey: string;
  initial?: string;
  initialVersion?: string;
  label: string;
  busy: boolean;
  allowEmpty?: boolean;
  onSubmit: (body: string, version?: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const draft = usePrDraft(storageKey, initial, initialVersion);
  const [preview, setPreview] = useState(false);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)}>
          {preview ? "Write" : "Preview"}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-24 rounded-md border p-3">
          <Markdown>{draft.value}</Markdown>
        </div>
      ) : (
        <Textarea
          aria-label={label}
          value={draft.value}
          disabled={busy}
          onChange={(e) => draft.update(e.target.value)}
          placeholder="Write Markdown…"
          className="min-h-24"
        />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || (!allowEmpty && !draft.value.trim())}
          onClick={async () => {
            if (await onSubmit(draft.value, draft.version)) draft.clear();
          }}
        >
          {busy ? "Saving…" : label}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            draft.reset();
            setPreview(false);
          }}
        >
          {initialVersion ? "Reset to GitHub" : "Discard draft"}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type Save = (input: Record<string, unknown>) => Promise<boolean>;
interface SectionProps {
  projectPath: string;
  repository: string;
  pr: PullRequestDetail;
  revision: string;
  busy: boolean;
  save: Save;
}

function EditDescription({
  pr,
  repository,
  busy,
  save,
  close,
}: {
  pr: PullRequestDetail;
  repository: string;
  busy: boolean;
  save: Save;
  close: () => void;
}) {
  const title = usePrDraft(
    draftKey(repository, pr.number, "title"),
    pr.title,
    pr.updatedAt,
  );
  return (
    <div className="space-y-3">
      <Input
        aria-label="PR title"
        value={title.value}
        disabled={busy}
        onChange={(e) => title.update(e.target.value)}
        maxLength={256}
      />
      <Button size="sm" variant="ghost" disabled={busy} onClick={title.reset}>
        Reset title to GitHub
      </Button>
      <Composer
        storageKey={draftKey(repository, pr.number, "description")}
        initial={pr.body}
        initialVersion={pr.updatedAt}
        label="Save description"
        allowEmpty
        busy={busy}
        onCancel={close}
        onSubmit={async (body, version) => {
          if (!title.value.trim()) return false;
          const ok = await save({
            action: "edit",
            title: title.value,
            body,
            updatedAt: [
              title.version ?? pr.updatedAt,
              version ?? pr.updatedAt,
            ].sort()[0],
          });
          if (ok) {
            title.clear();
            close();
          }
          return ok;
        }}
      />
    </div>
  );
}

function Comment({
  comment,
  repository,
  pr,
  busy,
  save,
  inline = false,
  children,
}: {
  comment: PrComment;
  repository: string;
  pr: PullRequestDetail;
  busy: boolean;
  save: Save;
  inline?: boolean;
  children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  const date = comment.created_at ?? comment.submitted_at ?? comment.updated_at;
  const submitted = Boolean(date) && Number.isFinite(new Date(date).getTime());
  return (
    <article className="rounded-lg border border-surface-200 dark:border-surface-800 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground"
          aria-hidden="true"
        >
          {comment.user.login.slice(0, 1).toUpperCase()}
        </span>
        <strong className="font-medium text-foreground">
          {comment.user.login}
        </strong>
        {comment.state ? (
          <span>{comment.state.replaceAll("_", " ")}</span>
        ) : null}
        <time
          dateTime={submitted ? date : undefined}
          title={submitted ? new Date(date).toLocaleString() : undefined}
        >
          {submitted
            ? formatDistanceToNow(new Date(date), { addSuffix: true })
            : "Not submitted"}
        </time>
        <button
          type="button"
          className="ml-auto hover:text-foreground"
          title="Open comment on GitHub"
          aria-label="Open comment on GitHub"
          onClick={() => openExternalUrl(comment.html_url)}
        >
          <ExternalLink className="size-3" />
        </button>
        {!inline && !comment.state && comment.user.login === pr.viewer ? (
          <button
            type="button"
            disabled={busy}
            className="hover:text-foreground"
            onClick={() => setEditing(!editing)}
          >
            Edit
          </button>
        ) : null}
      </div>
      {comment.path ? (
        <div className="break-all text-xs text-muted-foreground">
          {comment.path}:{comment.line ?? comment.original_line} ·{" "}
          {comment.side === "LEFT" ? "old" : "new"}
          {comment.line === null ? " · outdated" : ""}
        </div>
      ) : null}
      {editing ? (
        <Composer
          key={`edit-${comment.id}`}
          storageKey={draftKey(repository, pr.number, `comment-${comment.id}`)}
          initial={comment.body}
          initialVersion={comment.updated_at}
          label="Save comment"
          busy={busy}
          onCancel={() => setEditing(false)}
          onSubmit={async (body, version) => {
            const ok = await save({
              action: "editComment",
              commentId: comment.id,
              body,
              updatedAt: version ?? comment.updated_at,
            });
            if (ok) setEditing(false);
            return ok;
          }}
        />
      ) : (
        <Markdown>{comment.body}</Markdown>
      )}
      {children}
    </article>
  );
}

// Refresh loaded pages in place so selection, drafts, and pagination survive.
function usePrPage<T>(
  projectPath: string,
  repository: string,
  number: number,
  action: string,
  revision: string,
  commit?: string,
) {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void Promise.all(
      Array.from({ length: page }, (_, index) =>
        prRequest<Page<T>>(projectPath, {
          repository,
          number,
          action,
          page: index + 1,
          revision,
          commit,
        }),
      ),
    )
      .then(
        (pages) => {
          if (cancelled) return;
          const next = pages.flatMap((result) => result.items);
          setItems((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
          setHasMore(pages[pages.length - 1]?.hasMore ?? false);
        },
        (error) => {
          if (!cancelled) setError(message(error));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, repository, number, action, page, revision, commit]);
  return { items, error, loading, hasMore, more: () => setPage((p) => p + 1) };
}

function PageFooter({
  data,
}: {
  data: {
    error: string | null;
    loading: boolean;
    hasMore: boolean;
    more: () => void;
  };
}) {
  return (
    <>
      {data.error ? (
        <p role="alert" className="text-sm text-destructive">
          {data.error}
        </p>
      ) : null}
      {data.loading ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading…
        </p>
      ) : data.hasMore ? (
        <Button size="sm" variant="outline" onClick={data.more}>
          Load more
        </Button>
      ) : null}
    </>
  );
}

function SummaryComments({
  projectPath,
  repository,
  pr,
  revision,
  busy,
  save,
}: SectionProps) {
  const comments = usePrPage<PrComment>(
    projectPath,
    repository,
    pr.number,
    "comments",
    revision,
  );
  return (
    <section className="space-y-3">
      <h3 className="text-xs text-muted-foreground">Comments</h3>
      {comments.items.map((comment) => (
        <Comment
          key={comment.id}
          comment={comment}
          {...{ repository, pr, busy, save }}
        />
      ))}
      {!comments.items.length && !comments.loading && !comments.error ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : null}
      <PageFooter data={comments} />
      <Composer
        storageKey={draftKey(repository, pr.number, "new-comment")}
        label="Post comment"
        busy={busy}
        onSubmit={(body) => save({ action: "comment", body })}
      />
    </section>
  );
}

function Conversation(props: SectionProps) {
  const { projectPath, repository, pr, revision, busy, save } = props;
  const comments = usePrPage<PrComment>(
    projectPath,
    repository,
    pr.number,
    "comments",
    revision,
  );
  const reviews = usePrPage<PrComment>(
    projectPath,
    repository,
    pr.number,
    "reviews",
    revision,
  );
  const activity = [...comments.items, ...reviews.items].sort((a, b) =>
    (a.created_at ?? a.submitted_at ?? "").localeCompare(
      b.created_at ?? b.submitted_at ?? "",
    ),
  );
  const [event, setEvent] = useState("COMMENT");
  return (
    <div className="space-y-4">
      {activity.map((comment) => (
        <Comment
          key={`${comment.state ? "review" : "comment"}-${comment.id}`}
          comment={comment}
          {...{ repository, pr, busy, save }}
        />
      ))}
      {!activity.length && !comments.loading && !reviews.loading ? (
        <p className="text-sm text-muted-foreground">No conversation yet.</p>
      ) : null}
      <PageFooter data={comments} />
      <PageFooter data={reviews} />
      <Composer
        storageKey={draftKey(repository, pr.number, "new-comment")}
        label="Post comment"
        busy={busy}
        onSubmit={(body) => save({ action: "comment", body })}
      />
      {pr.state === "open" ? (
        <div className="border-t pt-4 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            Review
            <select
              aria-label="Review decision"
              className="rounded-md border bg-background p-2"
              value={event}
              disabled={busy}
              onChange={(e) => setEvent(e.target.value)}
            >
              <option value="COMMENT">Comment</option>
              {pr.author !== pr.viewer ? (
                <>
                  <option value="APPROVE">Approve</option>
                  <option value="REQUEST_CHANGES">Request changes</option>
                </>
              ) : null}
            </select>
          </label>
          <Composer
            storageKey={draftKey(repository, pr.number, "review")}
            label="Submit review"
            allowEmpty={event === "APPROVE"}
            busy={busy}
            onSubmit={(body) =>
              save({ action: "review", body, event, commit: pr.commit })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

function parsePullRequestDiff(file: PrFile) {
  if (!file.patch) return null;
  try {
    // GitHub supplies hunks only. Use fixed header paths so unusual filenames
    // cannot be interpreted as patch syntax; restore the real names afterwards.
    const header = [
      "diff --git a/file b/file",
      ...(file.status === "added"
        ? ["new file mode 100644"]
        : file.status === "removed"
          ? ["deleted file mode 100644"]
          : []),
      file.status === "added" ? "--- /dev/null" : "--- a/file",
      file.status === "removed" ? "+++ /dev/null" : "+++ b/file",
    ].join("\n");
    const diff = parsePatchFiles(
      `${header}\n${file.patch}\n`,
      undefined,
      true,
    )[0]?.files[0];
    if (!diff?.hunks.length) return null;
    return {
      ...diff,
      name: file.filename,
      prevName:
        file.previous_filename ??
        (file.status === "added" ? undefined : file.filename),
    };
  } catch {
    return null;
  }
}

interface PrDiffOptions {
  mode: DiffViewMode;
  wordWrap: boolean;
}

function FileDiff({
  file,
  repository,
  pr,
  busy,
  save,
  mode,
  wordWrap,
}: SectionProps & PrDiffOptions & { file: PrFile }) {
  const fileDiff = useMemo(() => parsePullRequestDiff(file), [file]);
  const [selection, setSelection] = useState<{
    line: number;
    side: "LEFT" | "RIGHT";
  } | null>(null);
  const selectLine = useCallback((range: SelectedLineRange) => {
    setSelection({
      line: range.start,
      side: range.side === "deletions" ? "LEFT" : "RIGHT",
    });
  }, []);
  return (
    <div className="space-y-3">
      {file.previous_filename ? (
        <div className="border-b border-surface-200 dark:border-surface-800 px-4 py-2 text-xs text-muted-foreground">
          {file.previous_filename} → {file.filename}
        </div>
      ) : null}
      {fileDiff ? (
        <div className={wordWrap ? "overflow-x-hidden" : "overflow-x-auto"}>
          <IdeDiffViewer
            className={wordWrap ? "min-w-0" : "min-w-[720px]"}
            diffStyle={mode}
            wordWrap={wordWrap}
            fileDiff={fileDiff}
            changedLineCount={file.additions + file.deletions}
            onLineComment={
              pr.state === "open" && !busy ? selectLine : undefined
            }
            selectedLines={
              selection
                ? {
                    start: selection.line,
                    end: selection.line,
                    side: selection.side === "LEFT" ? "deletions" : "additions",
                  }
                : null
            }
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {file.patch
            ? "This patch could not be displayed. Open on GitHub to inspect it."
            : "No text patch available. This file may be binary or too large; use Open on GitHub to inspect it."}
        </p>
      )}
      {selection ? (
        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {selection.side === "LEFT" ? "Old" : "New"} line {selection.line} ·{" "}
            {pr.commit.slice(0, 8)}
          </p>
          <Composer
            key={`${pr.commit}:${file.filename}:${selection.side}:${selection.line}`}
            storageKey={draftKey(
              repository,
              pr.number,
              `${pr.commit}:${file.filename}:${selection.side}:${selection.line}`,
            )}
            label="Post inline comment"
            busy={busy}
            onCancel={() => setSelection(null)}
            onSubmit={async (body) => {
              const ok = await save({
                action: "inline",
                body,
                path: file.filename,
                ...selection,
                commit: pr.commit,
              });
              if (ok) setSelection(null);
              return ok;
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

function PullRequestFileRow({
  file,
  threads,
  expanded,
  onExpandedChange,
  ...props
}: SectionProps &
  PrDiffOptions & {
    file: PrFile;
    threads: PrComment[];
    expanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
  }) {
  const { repository, pr, busy, save } = props;
  const [reply, setReply] = useState<number | null>(null);
  const roots = threads.filter(
    (comment) => comment.path === file.filename && !comment.in_reply_to_id,
  );
  const change: ProjectGitStatusEntry = {
    path: file.filename,
    previousPath: file.previous_filename ?? null,
    addedLines: file.additions,
    removedLines: file.deletions,
    status:
      file.status === "added"
        ? "untracked"
        : file.status === "removed"
          ? "deleted"
          : file.status === "renamed"
            ? "renamed"
            : file.status === "copied"
              ? "copied"
              : "modified",
    staged: false,
    unstaged: false,
  };
  return (
    <Collapsible
      open={expanded}
      onOpenChange={onExpandedChange}
      className="border-b border-surface-200 dark:border-surface-700 bg-background"
    >
      <FileChangeHeader
        change={change}
        expanded={expanded}
        onToggle={() => onExpandedChange(!expanded)}
      />
      <CollapsibleContent className="bg-surface-50 dark:bg-surface-900">
        <FileDiff file={file} {...props} />
        {roots.length > 0 ? (
          <div className="space-y-3 p-4">
            <h3 className="font-medium text-sm">Review threads</h3>
            {roots.map((root) => (
              <Comment
                key={root.id}
                comment={root}
                {...{ repository, pr, busy, save }}
                inline
              >
                {threads
                  .filter((c) => c.in_reply_to_id === root.id)
                  .map((comment) => (
                    <Comment
                      key={comment.id}
                      comment={comment}
                      {...{ repository, pr, busy, save }}
                      inline
                    />
                  ))}
                {reply === root.id ? (
                  <Composer
                    key={`reply-${root.id}`}
                    storageKey={draftKey(
                      repository,
                      pr.number,
                      `reply-${root.id}`,
                    )}
                    label="Reply"
                    busy={busy}
                    onCancel={() => setReply(null)}
                    onSubmit={async (body) => {
                      const ok = await save({
                        action: "reply",
                        commentId: root.id,
                        body,
                      });
                      if (ok) setReply(null);
                      return ok;
                    }}
                  />
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setReply(root.id)}
                  >
                    Reply
                  </Button>
                )}
              </Comment>
            ))}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Files({
  onRefresh,
  ...props
}: SectionProps & { onRefresh: () => void }) {
  const panelsT = useTranslations("panels");
  const [mode, setMode] = useState<DiffViewMode>("unified");
  const [wordWrap, setWordWrap] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const { projectPath, repository, pr, revision } = props;
  const files = usePrPage<PrFile>(
    projectPath,
    repository,
    pr.number,
    "files",
    revision,
    pr.commit,
  );
  const threads = usePrPage<PrComment>(
    projectPath,
    repository,
    pr.number,
    "threads",
    revision,
  );
  const allExpanded =
    files.items.length > 0 &&
    files.items.every((file) => expandedPaths.has(file.filename));
  const expandTitle = allExpanded
    ? panelsT("collapseAll")
    : panelsT("expandAll");
  const setFileExpanded = (path: string, expanded: boolean) =>
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (expanded) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <div>
      <div className="flex items-center gap-3 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2">
        <span className="min-w-0 flex-1 text-sm font-medium">Files</span>
        <SegmentedToggle<DiffViewMode>
          aria-label={`${panelsT("unifiedDiff")} / ${panelsT("splitDiff")}`}
          value={mode}
          onValueChange={setMode}
          options={[
            { icon: Rows3, label: panelsT("unifiedDiff"), value: "unified" },
            { icon: Columns2, label: panelsT("splitDiff"), value: "split" },
          ]}
        />
        <Button
          aria-label={expandTitle}
          title={expandTitle}
          className="size-7 p-0"
          disabled={!files.items.length}
          variant="outline"
          onClick={() =>
            setExpandedPaths(
              allExpanded
                ? new Set()
                : new Set(files.items.map((file) => file.filename)),
            )
          }
        >
          {allExpanded ? (
            <ChevronsDownUp className="size-3.5" />
          ) : (
            <ChevronsUpDown className="size-3.5" />
          )}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label={panelsT("changesActions")}
                title={panelsT("changesActions")}
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={onRefresh}>
              <RefreshCw className="size-4" />
              Refresh
            </DropdownMenuItem>
            <DropdownMenuCheckboxItem
              checked={wordWrap}
              onCheckedChange={setWordWrap}
            >
              <TextWrap className="size-4" />
              {panelsT("enableWordWrap")}
            </DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {files.items.map((file) => (
        <PullRequestFileRow
          key={`${file.filename}:${pr.commit}`}
          file={file}
          threads={threads.items}
          mode={mode}
          wordWrap={wordWrap}
          expanded={expandedPaths.has(file.filename)}
          onExpandedChange={(expanded) =>
            setFileExpanded(file.filename, expanded)
          }
          {...props}
        />
      ))}
      {files.loading || files.error || files.hasMore ? (
        <div className="p-4">
          <PageFooter data={files} />
        </div>
      ) : null}
      {threads.error || threads.hasMore ? (
        <div className="p-4">
          <PageFooter data={threads} />
        </div>
      ) : null}
    </div>
  );
}

function Detail({
  active,
  projectPath,
  repository,
  number,
  refreshKey,
}: {
  active: boolean;
  projectPath: string;
  repository: string;
  number: number;
  refreshKey: string;
}) {
  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    void prRequest<PullRequestDetail>(projectPath, {
      action: "detail",
      repository,
      number,
      revision,
      refreshKey,
    })
      .then(
        (data) => {
          if (!cancelled) {
            setPr(data);
            setError(null);
          }
        },
        (error) => {
          if (!cancelled) setError(message(error));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, repository, number, revision, refreshKey, active]);
  const save: Save = async (input) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setError(null);
    try {
      await prRequest(projectPath, { repository, number, ...input });
      setRevision((n) => n + 1);
      return true;
    } catch (error) {
      setError(message(error));
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const section = pr
    ? {
        projectPath,
        repository,
        pr,
        revision: `${revision}:${refreshKey}`,
        busy,
        save,
      }
    : null;
  const checks = pr ? checkSummary(pr.checks) : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {pr ? (
        <>
          <div className="space-y-3 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => openExternalUrl(pr.url)}
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title="Open on GitHub"
              >
                <span className="truncate">
                  {repository.split("/").slice(1).join("/")}
                </span>
                <span className="text-primary">#{pr.number}</span>
                <ExternalLink className="size-3 shrink-0" />
              </button>
              <PullRequestStatus pr={pr} />
            </div>
            <h2 className="break-words text-sm font-semibold leading-relaxed">
              {pr.title}
            </h2>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span
                className="flex size-5 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-foreground"
                aria-hidden="true"
              >
                {pr.author.slice(0, 1).toUpperCase()}
              </span>
              <span>{pr.author}</span>
              <span>·</span>
              <time
                dateTime={pr.updatedAt}
                title={new Date(pr.updatedAt).toLocaleString()}
              >
                Updated{" "}
                {formatDistanceToNow(new Date(pr.updatedAt), {
                  addSuffix: true,
                })}
              </time>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate" title={pr.base}>
                  {pr.base}
                </span>
                <ArrowLeft className="size-3 shrink-0" />
                <span className="truncate" title={pr.head}>
                  {pr.head}
                </span>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                <FileCode2 className="size-3" />
                {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
                <span className="text-success-foreground">+{pr.additions}</span>
                <span className="text-destructive">−{pr.deletions}</span>
              </span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-y border-surface-200 dark:border-surface-800 px-3 py-2">
            <nav
              className="inline-flex rounded-lg bg-muted p-0.5"
              aria-label="Pull request views"
            >
              {[
                { id: "overview", label: "Summary" },
                { id: "conversation", label: "Conversation" },
                { id: "files", label: "Code" },
              ].map((view) => (
                <button
                  type="button"
                  key={view.id}
                  aria-pressed={tab === view.id}
                  onClick={() => setTab(view.id)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    tab === view.id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {view.label}
                </button>
              ))}
            </nav>
            {checks ? (
              <div
                className={cn(
                  "flex items-center gap-1.5 text-xs",
                  checks.className,
                )}
              >
                <checks.icon className="size-3.5" />
                {checks.label}
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          tab !== "files" && "p-4 space-y-5",
        )}
      >
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive p-3 text-sm text-destructive whitespace-pre-wrap"
          >
            {error}
          </p>
        ) : null}
        {loading && !pr ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading pull request…
          </p>
        ) : null}
        {pr && section ? (
          tab === "overview" ? (
            <>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <Users className="size-3.5" />
                <span>Reviewers</span>
                <span className="text-foreground">
                  {pr.reviewers.join(", ") || "None"}
                </span>
              </div>
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs text-muted-foreground">Description</h3>
                  {pr.canEdit && !editing ? (
                    <button
                      type="button"
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setEditing(true)}
                    >
                      Edit
                    </button>
                  ) : null}
                </div>
                {editing ? (
                  <EditDescription
                    key={`${repository}:${number}`}
                    {...{ pr, repository, busy, save }}
                    close={() => setEditing(false)}
                  />
                ) : (
                  <Markdown>{pr.body}</Markdown>
                )}
              </section>
              <Collapsible defaultOpen>
                <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Checks
                  <ChevronDown className="size-3 transition-transform group-aria-expanded:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-3">
                  {pr.checks === null ? (
                    <p className="text-xs text-muted-foreground">
                      Checks unavailable.
                    </p>
                  ) : !pr.checks.length ? (
                    <p className="text-xs text-muted-foreground">
                      No checks reported.
                    </p>
                  ) : (
                    pr.checks.map((check) => {
                      const status = checkSummary([check]);
                      return (
                        <div
                          key={
                            check.id ??
                            `${check.name ?? check.context}:${check.detailsUrl ?? check.targetUrl}`
                          }
                          className="flex items-center justify-between gap-3 text-xs"
                        >
                          <span className="flex items-center gap-2">
                            <status.icon
                              className={cn("size-3.5", status.className)}
                            />
                            {check.name ?? check.context}
                          </span>
                          <span className="sr-only">{status.label}</span>
                        </div>
                      );
                    })
                  )}
                </CollapsibleContent>
              </Collapsible>
              <SummaryComments key={number} {...section} />
            </>
          ) : tab === "conversation" ? (
            <Conversation key={number} {...section} />
          ) : (
            <Files
              key={`${number}:${pr.commit}`}
              {...section}
              onRefresh={() => setRevision((value) => value + 1)}
            />
          )
        ) : null}
      </div>
    </div>
  );
}

function CreatePullRequest({
  project,
  close,
  completed,
}: {
  project: ProjectConfig;
  close: () => void;
  completed: () => void;
}) {
  const settings = useIdeStore((s) => s.settings);
  const refreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const selection = getDefaultGitGenerationModelSelection(settings);
  const { branch, status } = useProjectGitStatus(project.path, refreshKey, {
    detail: "full",
  });
  const bump = useIdeStore((s) => s.bumpProjectGitRefreshKey);
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  return (
    <CreatePrDialog
      open
      branch={branch}
      status={status}
      projectPath={project.path}
      refreshToken={refreshKey}
      {...selection}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onCompleted={(url, openOnGitHub) => {
        bump(project.id);
        if (url && openOnGitHub) openExternalUrl(url);
        completed();
        close();
      }}
    />
  );
}

export function PullRequestsPanel({
  project,
  active = true,
  onClosePanel,
}: {
  project: ProjectConfig;
  active?: boolean;
  onClosePanel: () => void;
}) {
  const refreshKey = useIdeStore(
    (s) => s.projectGitRefreshKeys[project.id] ?? 0,
  );
  const context = usePullRequestContext(project.path, refreshKey, active);
  const [revision, setRevision] = useState(0);
  const [create, setCreate] = useState(false);
  const repository = context.data?.repository;
  const current = context.data?.current;
  const refresh = () => {
    context.refresh();
    setRevision((n) => n + 1);
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-[50px] shrink-0 items-center gap-2 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2">
        <RightPanelHeaderIconButton
          icon={GitPullRequest}
          onClose={onClosePanel}
        />
        <span className="flex-1 truncate text-sm font-medium">
          Pull request
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[popup-open]:bg-muted data-[popup-open]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title="Pull request actions"
                aria-label="Pull request actions"
              />
            }
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={refresh}>
              <RefreshCw className="size-4" />
              Refresh
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {context.error ? (
        <div role="alert" className="p-4 text-sm space-y-3">
          <p className="text-destructive whitespace-pre-wrap">
            {context.error}
          </p>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : !repository ? (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Finding branch pull request…
        </p>
      ) : current ? (
        <div className="flex-1 min-h-0">
          <Detail
            key={`${repository}:${context.data?.branch}:${current.number}`}
            active={active}
            projectPath={project.path}
            repository={repository}
            number={current.number}
            refreshKey={String(revision)}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <GitPullRequest className="size-8 text-muted-foreground/50" />
          <h2 className="text-sm font-medium">
            No pull request for this branch
          </h2>
          <p className="max-w-xs break-words text-xs text-muted-foreground">
            {context.data?.branch
              ? `Create a pull request for ${context.data.branch} to review it here.`
              : "Check out a branch to view its pull request."}
          </p>
          {context.data?.branch ? (
            <Button size="sm" variant="outline" onClick={() => setCreate(true)}>
              Create pull request
            </Button>
          ) : null}
        </div>
      )}
      {create ? (
        <CreatePullRequest
          project={project}
          close={() => setCreate(false)}
          completed={refresh}
        />
      ) : null}
    </div>
  );
}
