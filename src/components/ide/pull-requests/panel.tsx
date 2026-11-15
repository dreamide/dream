import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleX,
  Clock3,
  Columns2,
  ExternalLink,
  File,
  GitBranch,
  GitMerge,
  type LucideIcon,
  Pencil,
  Rows3,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  InlineEditor,
  InlineEditorFooter,
} from "@/components/ui/inline-editor";
import { Input } from "@/components/ui/input";
import { SegmentedToggle } from "@/components/ui/segmented-toggle";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { Messages } from "@/i18n/messages";
import { type ProjectScope, projectScope } from "@/lib/project-resource-cache";
import { cn } from "@/lib/utils";
import type { ProjectConfig, ProjectGitStatusEntry } from "@/types/ide";
import type { DiffViewMode } from "../changes";
import { FileChangeHeader } from "../changes/file-change-header";
import { IdeDiffViewer } from "../diff-viewer";
import { GitPanelHeaderActions } from "../git-panel/header-actions";
import { AppShellPlaceholder } from "../ide-helpers";
import { useIdeStore } from "../ide-store";
import { WordWrapToggle } from "../word-wrap-toggle";
import {
  type PrComment,
  type PrFile,
  type PrWrite,
  type PullRequestChecks,
  type PullRequestDetail,
  type PullRequestSummary,
  usePrDraft,
  usePrPage,
  usePullRequestContext,
  usePullRequestRead,
  writePullRequest,
} from "./api";
import { PrMarkdownImage } from "./markdown-image";
import { MergePrDialog } from "./merge-pr-dialog";
import { PullRequestStatus } from "./status-badge";

const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const draftKey = (repository: string, number: number, kind: string) =>
  `dream:code-pr:${repository}:${number}:${kind}`;

/** How a checks outcome looks: its label, colour and icon. */
function checkPresentation(
  outcome: PullRequestChecks["outcome"],
  state: PullRequestSummary["state"] = "open",
  failedCount = 0,
): {
  labelKey: keyof Messages["pullRequests"];
  count?: number;
  className: string;
  icon: LucideIcon;
} {
  switch (outcome) {
    case "unavailable":
      return {
        className: "text-muted-foreground",
        icon: Clock3,
        labelKey: "checksUnavailable",
      };
    case "none":
      return {
        className: "text-muted-foreground",
        icon: CheckCircle2,
        labelKey: "noChecks",
      };
    case "failed":
      return {
        className:
          state === "open" ? "text-destructive" : "text-muted-foreground",
        count: failedCount,
        icon: CircleX,
        labelKey: "checksAttention",
      };
    case "pending":
      return {
        className: "text-amber-700 dark:text-amber-300",
        icon: Clock3,
        labelKey: "checksPending",
      };
    case "passed":
      return {
        className: "text-success-foreground",
        icon: CheckCircle2,
        labelKey: "checksPassed",
      };
  }
}

const prMarkdownComponents = {
  img: PrMarkdownImage,
} as NonNullable<StreamdownProps["components"]>;

function Markdown({ children }: { children: string }) {
  return (
    <div className="min-w-0 break-words text-sm leading-relaxed">
      <Streamdown mode="static" components={prMarkdownComponents}>
        {children || "—"}
      </Streamdown>
    </div>
  );
}

function Composer({
  storageKey,
  initial = "",
  initialVersion,
  label,
  showLabel = true,
  submitLabel = label,
  busy,
  onSubmit,
  onCancel,
  allowEmpty = false,
}: {
  storageKey: string;
  initial?: string;
  initialVersion?: string;
  label: string;
  showLabel?: boolean;
  submitLabel?: string;
  busy: boolean;
  allowEmpty?: boolean;
  onSubmit: (body: string, version?: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const t = useTranslations();
  const draft = usePrDraft(storageKey, initial, initialVersion);
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="space-y-2">
      {showLabel ? (
        <span className="text-xs text-muted-foreground">{label}</span>
      ) : null}
      <Tabs defaultValue="write">
        <TabsList aria-label={t("pullRequests.editorMode", { label })}>
          <TabsTrigger value="write">
            {t("assistant.toolGroup.write")}
          </TabsTrigger>
          <TabsTrigger value="preview">{t("aiElements.preview")}</TabsTrigger>
        </TabsList>
        <InlineEditor>
          <TabsContent value="write">
            <Textarea
              aria-label={label}
              value={draft.value}
              disabled={busy}
              onChange={(e) => draft.update(e.target.value)}
              placeholder={t("pullRequests.writeMarkdown")}
              className="min-h-24 p-3 text-sm leading-relaxed md:leading-relaxed"
            />
          </TabsContent>
          <TabsContent value="preview">
            <div className="min-h-24 p-3">
              <Markdown>{draft.value}</Markdown>
            </div>
          </TabsContent>
          <InlineEditorFooter>
            {onCancel ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  draft.clear();
                  onCancel();
                }}
              >
                {t("common.cancel")}
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={busy || (!allowEmpty && !draft.value.trim())}
              onClick={async () => {
                if (busy || submitting) return;
                setSubmitting(true);
                try {
                  if (await onSubmit(draft.value, draft.version)) draft.clear();
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              {submitting ? t("pullRequests.saving") : submitLabel}
            </Button>
          </InlineEditorFooter>
        </InlineEditor>
      </Tabs>
    </div>
  );
}

type Save = (input: Omit<PrWrite, "number" | "repository">) => Promise<boolean>;
interface SectionProps {
  scope: ProjectScope;
  repository: string;
  pr: PullRequestDetail;
  active: boolean;
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
  const t = useTranslations();
  return (
    <Composer
      storageKey={draftKey(repository, pr.number, "description")}
      initial={pr.body}
      initialVersion={pr.updatedAt}
      label={t("common.description")}
      showLabel={false}
      submitLabel={t("common.save")}
      allowEmpty
      busy={busy}
      onCancel={close}
      onSubmit={async (body, version) => {
        const ok = await save({
          action: "edit",
          body,
          updatedAt: version ?? pr.updatedAt,
        });
        if (ok) close();
        return ok;
      }}
    />
  );
}

function EditTitle({
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
  const t = useTranslations();
  const title = usePrDraft(
    draftKey(repository, pr.number, "title"),
    pr.title,
    pr.updatedAt,
  );
  const [submitting, setSubmitting] = useState(false);
  const cancel = () => {
    title.clear();
    close();
  };
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || submitting || !title.value.trim()) return;
        setSubmitting(true);
        try {
          if (
            await save({
              action: "edit",
              title: title.value,
              updatedAt: title.version ?? pr.updatedAt,
            })
          ) {
            title.clear();
            close();
          }
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <InlineEditor>
        <Input
          aria-label={t("pullRequests.prTitle")}
          value={title.value}
          disabled={busy}
          maxLength={256}
          onChange={(event) => title.update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) {
              event.preventDefault();
              cancel();
            }
          }}
        />
        <InlineEditorFooter>
          <Button
            size="sm"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={cancel}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            type="submit"
            disabled={busy || !title.value.trim()}
          >
            {submitting ? t("pullRequests.saving") : t("common.save")}
          </Button>
        </InlineEditorFooter>
      </InlineEditor>
    </form>
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
  const t = useTranslations();
  const format = useFormatter();
  const reviewLabel = (state: string) => {
    const keys = {
      APPROVED: "assistant.approved",
      CHANGES_REQUESTED: "pullRequests.changesRequested",
      COMMENTED: "pullRequests.commented",
      DISMISSED: "pullRequests.dismissed",
      PENDING: "assistant.toolState.input-streaming",
    } as const;
    return Object.hasOwn(keys, state)
      ? t(keys[state as keyof typeof keys])
      : state;
  };
  const [editing, setEditing] = useState(false);
  const date = comment.created_at ?? comment.submitted_at ?? comment.updated_at;
  const submitted = Boolean(date) && Number.isFinite(new Date(date).getTime());
  return (
    <article className="relative flex items-start gap-3">
      <Avatar className="mt-1">
        <AvatarImage src={comment.user.avatar_url} alt={comment.user.login} />
        <AvatarFallback>
          {comment.user.login.slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="relative min-w-0 flex-1 rounded-lg bg-surface-50 text-foreground dark:bg-surface-900">
        <div className="flex min-h-10 flex-wrap items-center gap-2 px-4 pt-3 text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">
            {comment.user.login}
          </strong>
          {comment.state ? <span>{reviewLabel(comment.state)}</span> : null}
          <time
            dateTime={submitted ? date : undefined}
            title={
              submitted
                ? format.dateTime(new Date(date), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : undefined
            }
          >
            {submitted
              ? format.relativeTime(new Date(date))
              : t("pullRequests.notSubmitted")}
          </time>
          {!inline && !comment.state && comment.user.login === pr.viewer ? (
            <button
              type="button"
              disabled={busy}
              className="ml-auto hover:text-foreground"
              onClick={() => setEditing(!editing)}
            >
              {t("common.edit")}
            </button>
          ) : null}
        </div>
        <div className="space-y-3 px-4 py-3">
          {comment.path ? (
            <div className="break-all text-xs text-muted-foreground">
              {comment.path}:{comment.line ?? comment.original_line} ·{" "}
              {comment.side === "LEFT"
                ? t("pullRequests.old")
                : t("pullRequests.new")}
              {comment.line === null ? ` · ${t("pullRequests.outdated")}` : ""}
            </div>
          ) : null}
          {editing ? (
            <Composer
              key={`edit-${comment.id}`}
              storageKey={draftKey(
                repository,
                pr.number,
                `comment-${comment.id}`,
              )}
              initial={comment.body}
              initialVersion={comment.updated_at}
              label={t("pullRequests.comment")}
              showLabel={false}
              submitLabel={t("common.save")}
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
        </div>
      </div>
    </article>
  );
}

function PullRequestLoading({ fill = false }: { fill?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center",
        fill ? "h-full min-h-0 flex-1" : "py-6",
      )}
    >
      <Spinner className="size-4 text-muted-foreground" />
    </div>
  );
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
  const t = useTranslations();
  return (
    <>
      {data.error ? (
        <p role="alert" className="text-sm text-destructive">
          {data.error}
        </p>
      ) : null}
      {data.loading ? (
        <PullRequestLoading />
      ) : data.hasMore ? (
        <Button size="sm" variant="outline" onClick={data.more}>
          {t("pullRequests.loadMore")}
        </Button>
      ) : null}
    </>
  );
}

function SummaryComments(props: SectionProps) {
  const t = useTranslations();
  const { scope, repository, pr, active, busy, save } = props;
  const comments = usePrPage<PrComment>(
    scope,
    repository,
    pr.number,
    "comments",
    active,
  );
  const reviews = usePrPage<PrComment>(
    scope,
    repository,
    pr.number,
    "reviews",
    active,
  );
  const activity = [...comments.items, ...reviews.items].sort((a, b) =>
    (a.created_at ?? a.submitted_at ?? "").localeCompare(
      b.created_at ?? b.submitted_at ?? "",
    ),
  );
  return (
    <Collapsible defaultOpen>
      <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {t("pullRequests.comments")}
        <ChevronDown className="size-3 transition-transform group-aria-expanded:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted className="space-y-4 pt-3">
        <div className="relative space-y-6 before:absolute before:inset-y-0 before:left-[60px] before:w-px before:bg-surface-300 dark:before:bg-surface-700 empty:hidden">
          {activity.map((comment) => (
            <Comment
              key={`${comment.state ? "review" : "comment"}-${comment.id}`}
              comment={comment}
              {...{ repository, pr, busy, save }}
            />
          ))}
        </div>
        <PageFooter data={comments} />
        <PageFooter data={reviews} />
        <Composer
          storageKey={draftKey(repository, pr.number, "new-comment")}
          label={t("pullRequests.postComment")}
          showLabel={false}
          busy={busy}
          onSubmit={(body) => save({ action: "comment", body })}
        />
      </CollapsibleContent>
    </Collapsible>
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
  const t = useTranslations();
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
            ? t("pullRequests.patchUnavailable")
            : t("pullRequests.noPatch")}
        </p>
      )}
      {selection ? (
        <div className="rounded-md border p-3">
          <p className="mb-2 text-xs text-muted-foreground">
            {t(
              selection.side === "LEFT"
                ? "pullRequests.oldLine"
                : "pullRequests.newLine",
              { line: selection.line },
            )}{" "}
            · {pr.commit.slice(0, 8)}
          </p>
          <Composer
            key={`${pr.commit}:${file.filename}:${selection.side}:${selection.line}`}
            storageKey={draftKey(
              repository,
              pr.number,
              `${pr.commit}:${file.filename}:${selection.side}:${selection.line}`,
            )}
            label={t("pullRequests.postInlineComment")}
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
  const t = useTranslations();
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
            <h3 className="font-medium text-sm">
              {t("pullRequests.reviewThreads")}
            </h3>
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
                    label={t("pullRequests.reply")}
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
                    {t("pullRequests.reply")}
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

function Files(props: SectionProps) {
  const t = useTranslations();
  const panelsT = useTranslations("panels");
  const [mode, setMode] = useState<DiffViewMode>("unified");
  const [wordWrap, setWordWrap] = useState(true);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => new Set(),
  );
  const { scope, repository, pr, active } = props;
  const files = usePrPage<PrFile>(
    scope,
    repository,
    pr.number,
    "files",
    active,
    pr.commit,
  );
  const threads = usePrPage<PrComment>(
    scope,
    repository,
    pr.number,
    "threads",
    active,
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
        <span className="min-w-0 flex-1 text-sm font-medium">
          {t("common.files")}
        </span>
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
        <WordWrapToggle onPressedChange={setWordWrap} pressed={wordWrap} />
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
  scope,
  repository,
  number,
}: {
  active: boolean;
  scope: ProjectScope;
  repository: string;
  number: number;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const resource = usePullRequestRead<PullRequestDetail>(
    scope,
    { action: "detail", repository, number },
    active,
  );
  const pr = resource.data ?? null;
  const [writeError, setError] = useState<string | null>(null);
  const error =
    writeError ??
    (resource.error === undefined
      ? null
      : message(resource.error, t("ui.requestFailed")));
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(true);
  const [checksOpen, setChecksOpen] = useState(true);
  const [checksNavigation, setChecksNavigation] = useState(0);
  const checksSection = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!checksNavigation || tab !== "overview") return;
    checksSection.current?.scrollIntoView({ block: "nearest" });
    checksSection.current?.focus({ preventScroll: true });
  }, [checksNavigation, tab]);
  const [editingTitle, setEditingTitle] = useState(false);
  const loading = resource.loading || resource.version === null;
  const openExternalUrl = useIdeStore((s) => s.openExternalUrl);
  const save: Save = async (input) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    setError(null);
    try {
      await writePullRequest(scope, {
        repository,
        number,
        ...input,
      });
      return true;
    } catch (error) {
      setError(message(error, t("ui.requestFailed")));
      return false;
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };
  const section = pr
    ? {
        scope,
        repository,
        pr,
        active,
        busy,
        save,
      }
    : null;
  const checks = pr
    ? checkPresentation(pr.checks.outcome, pr.state, pr.checks.failedCount)
    : null;
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(String(value))}
      className="h-full min-h-0 flex-col gap-0"
    >
      {pr ? (
        <>
          <div className="space-y-2 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => openExternalUrl(pr.url)}
                className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                title={t("pullRequests.openGitHub")}
              >
                <span className="truncate">
                  {repository.split("/").slice(1).join("/")}
                </span>
                <span className="text-primary">#{pr.number}</span>
                <ExternalLink className="size-3 shrink-0" />
              </button>
              <PullRequestStatus pr={pr} />
            </div>
            {editingTitle ? (
              <EditTitle
                key={`${repository}:${number}`}
                {...{ pr, repository, busy, save }}
                close={() => setEditingTitle(false)}
              />
            ) : (
              <div className="group/title flex items-start gap-2">
                <h2 className="min-w-0 flex-1 break-words text-sm font-semibold leading-relaxed">
                  {pr.title}
                </h2>
                {pr.canEdit ? (
                  <button
                    type="button"
                    aria-label={t("pullRequests.editTitle")}
                    title={t("pullRequests.editTitle")}
                    disabled={busy}
                    className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100 focus-visible:opacity-100 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setEditingTitle(true)}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                ) : null}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Avatar className="size-5">
                <AvatarImage
                  src={
                    pr.authorAvatarUrl ||
                    (repository.startsWith("github.com/") && pr.author
                      ? `https://github.com/${encodeURIComponent(pr.author)}.png?size=40`
                      : undefined)
                  }
                  alt={pr.author}
                />
                <AvatarFallback className="text-[10px]">
                  {pr.author.slice(0, 1).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span>{pr.author}</span>
              <span>·</span>
              <time
                dateTime={pr.updatedAt}
                title={format.dateTime(new Date(pr.updatedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              >
                {t("pullRequests.updated", {
                  time: format.relativeTime(new Date(pr.updatedAt)),
                })}
              </time>

              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
                <div className="flex min-w-0 items-center gap-2">
                  <GitBranch className="size-3 shrink-0" />
                  <span className="truncate" title={pr.head}>
                    {pr.head}
                  </span>
                  <ArrowRight className="size-3 shrink-0" />
                  <span className="truncate" title={pr.base}>
                    {pr.base}
                  </span>
                </div>
                <span className="flex shrink-0 items-center gap-2 font-mono tabular-nums">
                  <File className="size-3" />
                  {t("ui.fileCount", { count: pr.changedFiles })}
                  <span className="text-emerald-600">+{pr.additions}</span>
                  <span className="text-rose-600">−{pr.deletions}</span>
                </span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-surface-200 dark:border-surface-800 px-3 py-2">
            <TabsList aria-label={t("pullRequests.views")}>
              <TabsTrigger value="overview">
                {t("pullRequests.summary")}
              </TabsTrigger>
              <TabsTrigger value="files">
                {t("workspace.workspaceCode")}
              </TabsTrigger>
            </TabsList>
            {checks ? (
              <Button
                variant="ghost"
                size="xs"
                title={
                  pr.state === "merged" && checks.count
                    ? t("pullRequests.mergedChecksFailed")
                    : t("pullRequests.checks")
                }
                onClick={() => {
                  setTab("overview");
                  setChecksOpen(true);
                  setChecksNavigation((value) => value + 1);
                }}
                className={cn(
                  "ml-auto flex items-center gap-1.5 text-xs",
                  checks.className,
                )}
              >
                <checks.icon className="size-3.5" />
                {t(`pullRequests.${checks.labelKey}`, {
                  count: checks.count ?? 0,
                })}
              </Button>
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
        {loading && !pr ? <PullRequestLoading fill /> : null}
        {pr && section ? (
          tab === "overview" ? (
            <TabsContent value="overview" className="space-y-5">
              <Collapsible
                className="group/description"
                open={descriptionOpen}
                onOpenChange={setDescriptionOpen}
              >
                <div className="flex items-center justify-between gap-2">
                  <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {t("common.description")}
                    <ChevronDown className="size-3 transition-transform group-aria-expanded:rotate-180" />
                  </CollapsibleTrigger>
                  {pr.canEdit && !editing ? (
                    <button
                      type="button"
                      aria-label={t("pullRequests.editDescription")}
                      title={t("pullRequests.editDescription")}
                      className="flex size-7 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover/description:opacity-100 focus-visible:opacity-100 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => {
                        setDescriptionOpen(true);
                        setEditing(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  ) : null}
                </div>
                <CollapsibleContent keepMounted className="pt-3">
                  {editing ? (
                    <EditDescription
                      key={`${repository}:${number}`}
                      {...{ pr, repository, busy, save }}
                      close={() => setEditing(false)}
                    />
                  ) : (
                    <Markdown>{pr.body}</Markdown>
                  )}
                </CollapsibleContent>
              </Collapsible>
              <Collapsible
                ref={checksSection}
                tabIndex={-1}
                open={checksOpen}
                onOpenChange={setChecksOpen}
              >
                <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t("pullRequests.checks")}
                  <ChevronDown className="size-3 transition-transform group-aria-expanded:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-3">
                  {pr.checks.outcome === "unavailable" ? (
                    <p className="text-xs text-muted-foreground">
                      {t("pullRequests.checksUnavailable")}
                    </p>
                  ) : !pr.checks.items.length ? (
                    <p className="text-xs text-muted-foreground">
                      {t("pullRequests.noChecks")}
                    </p>
                  ) : (
                    pr.checks.items.map((check) => {
                      const status = checkPresentation(
                        check.outcome,
                        pr.state,
                        check.outcome === "failed" ? 1 : 0,
                      );
                      const { url } = check;
                      return (
                        <div
                          key={check.key}
                          className="flex items-center justify-between gap-3 text-xs"
                        >
                          <span className="flex items-center gap-2">
                            <status.icon
                              className={cn("size-3.5", status.className)}
                            />
                            {url ? (
                              <Button
                                variant="link"
                                size="xs"
                                className="h-auto whitespace-normal p-0 text-inherit"
                                onClick={() => openExternalUrl(url)}
                              >
                                {check.name}
                                <ExternalLink className="size-3 shrink-0" />
                              </Button>
                            ) : (
                              check.name
                            )}
                          </span>
                          <span className="sr-only">
                            {t(`pullRequests.${status.labelKey}`, {
                              count: status.count ?? 0,
                            })}
                          </span>
                        </div>
                      );
                    })
                  )}
                </CollapsibleContent>
              </Collapsible>
              <SummaryComments key={number} {...section} />
            </TabsContent>
          ) : (
            <TabsContent value="files" className="h-full">
              <Files key={`${number}:${pr.commit}`} {...section} />
            </TabsContent>
          )
        ) : null}
      </div>
    </Tabs>
  );
}

/** The pull request for the project's current branch: the Git panel's tab. */
export function PullRequestView({
  project,
  active = true,
}: {
  project: ProjectConfig;
  active?: boolean;
}) {
  const t = useTranslations();
  const scope = projectScope(project);
  const context = usePullRequestContext(project.path, active, scope.hostId);
  const [mergeTarget, setMergeTarget] = useState<{
    repository: string;
    number: number;
  } | null>(null);
  const repository = context.data?.repository;
  const current = context.data?.current;
  const refresh = () => {
    context.refresh();
  };
  const panelsT = useTranslations("panels");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <GitPanelHeaderActions active={active}>
        {current?.state === "open" ? (
          <Button
            size="sm"
            disabled={current.draft || !repository}
            onClick={() => {
              if (repository)
                setMergeTarget({ repository, number: current.number });
            }}
            title={
              current.draft
                ? t("pullRequests.markReady")
                : t("pullRequests.mergePr")
            }
          >
            <GitMerge className="size-3.5" />
            {t("worktrees.merge")}
          </Button>
        ) : null}
      </GitPanelHeaderActions>
      {context.error ? (
        <div role="alert" className="p-4 text-sm space-y-3">
          <p className="text-destructive whitespace-pre-wrap">
            {context.error}
          </p>
          <Button size="sm" variant="outline" onClick={refresh}>
            {t("pullRequests.retry")}
          </Button>
        </div>
      ) : !repository ? (
        <PullRequestLoading fill />
      ) : current ? (
        <div className="flex-1 min-h-0">
          <Detail
            key={`${scope.hostId}:${project.path}:${repository}:${context.data?.branch}:${current.number}`}
            active={active}
            scope={scope}
            repository={repository}
            number={current.number}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <AppShellPlaceholder message={panelsT("noPullRequestForBranch")} />
        </div>
      )}
      {mergeTarget ? (
        <MergePrDialog
          key={`${scope.hostId}:${project.path}:${mergeTarget.repository}:${mergeTarget.number}`}
          scope={scope}
          repository={mergeTarget.repository}
          number={mergeTarget.number}
          onClose={() => setMergeTarget(null)}
        />
      ) : null}
    </div>
  );
}
