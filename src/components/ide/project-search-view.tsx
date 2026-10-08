import {
  CaseSensitive,
  ChevronRight,
  ListFilter,
  Regex as RegexIcon,
  WholeWord,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import {
  apiClient,
  getApiErrorMessage,
  isAbortError,
  type ProjectSearchFile,
  type ProjectSearchLine,
  type ProjectSearchResponse,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { MaterialFileIcon } from "./material-file-icon";
import type { ProjectFilePosition } from "./store/ide-store-types";

const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_MAX_RESULTS = 2000;
const ROW_SELECTOR = "[data-search-row]";

type SearchState =
  | { status: "idle" }
  | { status: "loading"; response: ProjectSearchResponse | null }
  | { status: "done"; response: ProjectSearchResponse }
  | { status: "error"; message: string };

export interface ProjectSearchViewProps {
  /** Bumped to focus (and select) the query. */
  focusRequest: number;
  /** Opens a match: previews it, or keeps it open (`pin`, a double-click). */
  onOpenResult: (
    path: string,
    position: ProjectFilePosition,
    options: { pin: boolean },
  ) => void;
  projectPath: string;
  /** Bumped when the project's files may have changed; searches again. */
  refreshVersion: number;
  /**
   * The panel's toolbar row to render the query into, while search is the
   * visible mode; null otherwise.
   */
  toolbarSlot: HTMLElement | null;
}

const splitPath = (path: string) => {
  const index = path.lastIndexOf("/");
  return index === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, index), name: path.slice(index + 1) };
};

const renderPreview = ({ preview, ranges }: ProjectSearchLine) => {
  const parts: ReactNode[] = [];
  let offset = 0;
  for (const [start, end] of ranges) {
    if (start > offset) parts.push(preview.slice(offset, start));
    parts.push(
      <mark className="rounded-xs bg-amber-500/30 text-foreground" key={start}>
        {preview.slice(start, end)}
      </mark>,
    );
    offset = end;
  }
  if (offset < preview.length) parts.push(preview.slice(offset));
  return parts;
};

const countMatches = (file: ProjectSearchFile) =>
  file.lines.reduce((total, line) => total + line.matchCount, 0);

/**
 * Find in files for one project: a query with its options, and the matching
 * lines grouped by file. Opening a line is the parent's job.
 */
export const ProjectSearchView = ({
  focusRequest,
  onOpenResult,
  projectPath,
  refreshVersion,
  toolbarSlot,
}: ProjectSearchViewProps) => {
  const t = useTranslations("fileSearch");
  const panelsT = useTranslations("panels");
  const editorSearchT = useTranslations("editorSearch");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [collapsedPaths, setCollapsedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [openedRow, setOpenedRow] = useState<string | null>(null);
  const queryRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusRequest === 0) return;
    queryRef.current?.querySelector("input")?.select();
  }, [focusRequest]);

  useEffect(() => {
    void refreshVersion;
    if (!query) {
      setSearch({ status: "idle" });
      return;
    }

    setSearch((current) => ({
      response:
        current.status === "done" || current.status === "loading"
          ? current.response
          : null,
      status: "loading",
    }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiClient
        .searchProjectFiles(
          {
            caseSensitive,
            exclude,
            include,
            maxResults: SEARCH_MAX_RESULTS,
            projectPath,
            query,
            regexp,
            wholeWord,
          },
          { signal: controller.signal },
        )
        .then((response) => {
          setCollapsedPaths(new Set());
          setOpenedRow(null);
          setSearch({ response, status: "done" });
        })
        .catch((error: unknown) => {
          if (isAbortError(error)) return;
          setSearch({
            message: getApiErrorMessage(error, t("failed")),
            status: "error",
          });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    caseSensitive,
    exclude,
    include,
    projectPath,
    query,
    refreshVersion,
    regexp,
    t,
    wholeWord,
  ]);

  const toggleCollapsed = (path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const openLine = (
    path: string,
    { column, length, line }: ProjectSearchLine,
    pin: boolean,
  ) => {
    setOpenedRow(`${path}:${line}`);
    onOpenResult(path, { column, length, line }, { pin });
  };

  // Up and down step through the rows, like a tree.
  const handleResultsKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      resultsRef.current?.querySelectorAll<HTMLElement>(ROW_SELECTOR) ?? [],
    );
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  const response =
    search.status === "done" || search.status === "loading"
      ? search.response
      : null;
  const filtersActive = Boolean(include.trim() || exclude.trim());

  let status: ReactNode = null;
  if (search.status === "error") {
    status = <span className="text-destructive">{search.message}</span>;
  } else if (search.status === "idle") {
    status = t("hint");
  } else if (search.status === "done" && search.response.matchCount === 0) {
    status = t("noResults");
  } else if (response) {
    status = t("summary", {
      files: response.files.length,
      matches: response.matchCount,
    });
  }

  return (
    <div className="flex h-full flex-col">
      {toolbarSlot
        ? createPortal(
            <div ref={queryRef}>
              <SearchInput
                aria-label={t("title")}
                clearLabel={panelsT("clearSearch")}
                onValueChange={setQuery}
                placeholder={t("title")}
                value={query}
              />
            </div>,
            toolbarSlot,
          )
        : null}
      <div className="shrink-0 space-y-2 px-3 pb-2">
        <div className="flex items-center gap-1">
          <Toggle
            aria-label={editorSearchT("matchCase")}
            onPressedChange={setCaseSensitive}
            pressed={caseSensitive}
            size="sm"
            title={editorSearchT("matchCase")}
          >
            <CaseSensitive />
          </Toggle>
          <Toggle
            aria-label={editorSearchT("wholeWord")}
            onPressedChange={setWholeWord}
            pressed={wholeWord}
            size="sm"
            title={editorSearchT("wholeWord")}
          >
            <WholeWord />
          </Toggle>
          <Toggle
            aria-label={editorSearchT("regexp")}
            onPressedChange={setRegexp}
            pressed={regexp}
            size="sm"
            title={editorSearchT("regexp")}
          >
            <RegexIcon />
          </Toggle>
          <div className="flex-1" />
          <Toggle
            aria-expanded={filtersOpen}
            aria-label={t("filters")}
            className="relative"
            onPressedChange={setFiltersOpen}
            pressed={filtersOpen}
            size="sm"
            title={t("filters")}
          >
            <ListFilter />
            {filtersActive && !filtersOpen ? (
              <span
                aria-hidden="true"
                className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary"
              />
            ) : null}
          </Toggle>
        </div>
        {filtersOpen ? (
          <div className="space-y-2">
            <Input
              aria-label={t("include")}
              autoComplete="off"
              className="h-8 bg-surface-50 font-mono text-xs md:text-xs dark:bg-surface-900"
              onChange={(event) => setInclude(event.target.value)}
              placeholder={t("includePlaceholder")}
              spellCheck={false}
              value={include}
            />
            <Input
              aria-label={t("exclude")}
              autoComplete="off"
              className="h-8 bg-surface-50 font-mono text-xs md:text-xs dark:bg-surface-900"
              onChange={(event) => setExclude(event.target.value)}
              placeholder={t("excludePlaceholder")}
              spellCheck={false}
              value={exclude}
            />
          </div>
        ) : null}
      </div>

      <div
        aria-live="polite"
        className="flex min-h-6 shrink-0 items-center gap-2 px-3 pb-1 text-muted-foreground text-xs"
      >
        {search.status === "loading" ? (
          <Spinner className="size-3 shrink-0" />
        ) : null}
        <span className="min-w-0 truncate">{status}</span>
      </div>
      {search.status === "done" && search.response.truncated ? (
        <div className="shrink-0 px-3 pb-1 text-muted-foreground text-xs">
          {t("truncated", { count: search.response.matchCount })}
        </div>
      ) : null}

      {/* biome-ignore lint/a11y/noStaticElementInteractions: arrow keys move focus between the row buttons inside. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto pb-2 transition-opacity",
          search.status === "loading" && "opacity-60",
        )}
        onKeyDown={handleResultsKeyDown}
        ref={resultsRef}
      >
        {response?.files.map((file) => {
          const collapsed = collapsedPaths.has(file.path);
          const { directory, name } = splitPath(file.path);
          return (
            <div key={file.path}>
              <button
                aria-expanded={!collapsed}
                className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted"
                data-search-row=""
                onClick={() => toggleCollapsed(file.path)}
                title={file.path}
                type="button"
              >
                <ChevronRight
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    !collapsed && "rotate-90",
                  )}
                />
                <MaterialFileIcon
                  className="size-4 shrink-0"
                  path={file.path}
                />
                <span className="shrink-0 truncate text-foreground">
                  {name}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {directory}
                </span>
                <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground tabular-nums">
                  {countMatches(file)}
                </span>
              </button>
              {collapsed
                ? null
                : file.lines.map((line) => {
                    const rowKey = `${file.path}:${line.line}`;
                    return (
                      <button
                        className={cn(
                          "flex h-6 w-full items-center pr-2 pl-9 text-left font-mono text-[11px] text-muted-foreground outline-none hover:bg-muted focus-visible:bg-muted",
                          openedRow === rowKey && "bg-muted text-foreground",
                        )}
                        data-search-row=""
                        key={line.line}
                        onClick={() => openLine(file.path, line, false)}
                        onDoubleClick={() => openLine(file.path, line, true)}
                        title={t("line", { line: line.line })}
                        type="button"
                      >
                        <span className="truncate whitespace-pre">
                          {renderPreview(line)}
                        </span>
                      </button>
                    );
                  })}
            </div>
          );
        })}
      </div>
    </div>
  );
};
