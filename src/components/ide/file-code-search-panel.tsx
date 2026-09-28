import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView, Panel, ViewUpdate } from "@uiw/react-codemirror";
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  ListChecks,
  Regex as RegexIcon,
  ReplaceAll as ReplaceAllIcon,
  Replace as ReplaceIcon,
  WholeWord,
} from "lucide-react";
import type { useTranslations } from "next-intl";
import type { KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";

type Translate = ReturnType<typeof useTranslations>;

interface FileCodeSearchPanelContentProps {
  t: Translate;
  matchPosition: { current: number; total: number } | null;
  onCaseSensitiveChange: (pressed: boolean) => void;
  onClose: () => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onRegexpChange: (pressed: boolean) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onReplaceChange: (value: string) => void;
  onSearchChange: (value: string) => void;
  onSelectAll: () => void;
  onWholeWordChange: (pressed: boolean) => void;
  query: SearchQuery;
  readOnly: boolean;
}

const FileCodeSearchPanelContent = ({
  t,
  matchPosition,
  onCaseSensitiveChange,
  onClose,
  onFindNext,
  onFindPrevious,
  onRegexpChange,
  onReplace,
  onReplaceAll,
  onReplaceChange,
  onSearchChange,
  onSelectAll,
  onWholeWordChange,
  query,
  readOnly,
}: FileCodeSearchPanelContentProps) => {
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    if (event.shiftKey) {
      onFindPrevious();
    } else {
      onFindNext();
    }
  };

  const handleReplaceKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      onReplace();
    }
  };

  return (
    <form
      className="flex w-full flex-col gap-2 p-2.5"
      onSubmit={(event) => event.preventDefault()}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="relative min-w-32 flex-1">
          <Input
            aria-invalid={query.search.length > 0 && !query.valid}
            aria-label={t("editorSearch.find")}
            autoComplete="off"
            className="h-8 bg-surface-50 pr-14 text-xs text-foreground md:text-xs dark:bg-surface-900"
            onChange={(event) => onSearchChange(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={t("editorSearch.find")}
            ref={(element) => element?.setAttribute("main-field", "true")}
            spellCheck={false}
            value={query.search}
          />
          {matchPosition ? (
            <span
              className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center font-mono text-[11px] text-muted-foreground tabular-nums"
              title={t("editorSearch.matchPosition", matchPosition)}
            >
              {matchPosition.current}/{matchPosition.total}
            </span>
          ) : null}
        </div>
        <Button
          aria-label={t("editorSearch.previousMatch")}
          disabled={!query.valid}
          onClick={onFindPrevious}
          size="icon-sm"
          title={t("editorSearch.previousMatch")}
          type="button"
          variant="ghost"
        >
          <ChevronUp />
        </Button>
        <Button
          aria-label={t("editorSearch.nextMatch")}
          disabled={!query.valid}
          onClick={onFindNext}
          size="icon-sm"
          title={t("editorSearch.nextMatch")}
          type="button"
          variant="ghost"
        >
          <ChevronDown />
        </Button>
        <Button
          aria-label={t("editorSearch.selectAllMatches")}
          disabled={!query.valid}
          onClick={onSelectAll}
          size="icon-sm"
          title={t("editorSearch.selectAllMatches")}
          type="button"
          variant="ghost"
        >
          <ListChecks />
        </Button>
        <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
        <Toggle
          aria-label={t("editorSearch.matchCase")}
          onPressedChange={onCaseSensitiveChange}
          pressed={query.caseSensitive}
          size="sm"
          title={t("editorSearch.matchCase")}
        >
          <CaseSensitive />
        </Toggle>
        <Toggle
          aria-label={t("editorSearch.regexp")}
          onPressedChange={onRegexpChange}
          pressed={query.regexp}
          size="sm"
          title={t("editorSearch.regexp")}
        >
          <RegexIcon />
        </Toggle>
        <Toggle
          aria-label={t("editorSearch.wholeWord")}
          onPressedChange={onWholeWordChange}
          pressed={query.wholeWord}
          size="sm"
          title={t("editorSearch.wholeWord")}
        >
          <WholeWord />
        </Toggle>
      </div>

      {!readOnly ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <Input
            aria-label={t("editorSearch.replace")}
            autoComplete="off"
            className="h-8 min-w-32 flex-1 bg-surface-50 text-xs text-foreground md:text-xs dark:bg-surface-900"
            onChange={(event) => onReplaceChange(event.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder={t("editorSearch.replace")}
            spellCheck={false}
            value={query.replace}
          />
          <Button
            className="text-xs"
            disabled={!query.valid}
            onClick={onReplace}
            size="sm"
            title={t("editorSearch.replaceCurrent")}
            type="button"
            variant="outline"
          >
            <ReplaceIcon />
            {t("editorSearch.replace")}
          </Button>
          <Button
            className="text-xs"
            disabled={!query.valid}
            onClick={onReplaceAll}
            size="sm"
            title={t("editorSearch.replaceAllMatches")}
            type="button"
            variant="outline"
          >
            <ReplaceAllIcon />
            {t("editorSearch.replaceAll")}
          </Button>
        </div>
      ) : null}
    </form>
  );
};

class FileCodeSearchPanel implements Panel {
  readonly dom = document.createElement("div");
  readonly top = true;

  private readonly onOpenChange: (open: boolean) => void;
  private readonly root: Root;
  private readonly getTranslate: () => Translate;
  private t: Translate;
  private query: SearchQuery;
  private readOnly: boolean;
  private view: EditorView;

  constructor(
    view: EditorView,
    onOpenChange: (open: boolean) => void,
    getTranslate: () => Translate,
  ) {
    this.getTranslate = getTranslate;
    this.t = getTranslate();
    this.view = view;
    this.onOpenChange = onOpenChange;
    this.query = getSearchQuery(view.state);
    this.readOnly = view.state.readOnly;
    this.dom.className = "cm-search";
    this.root = createRoot(this.dom);
    flushSync(() => this.render());
  }

  mount() {
    this.onOpenChange(true);
    const searchField =
      this.dom.querySelector<HTMLInputElement>("[main-field]");
    if (searchField) {
      searchField.focus();
      searchField.select();
    }
  }

  update(update: ViewUpdate) {
    this.view = update.view;
    const query = getSearchQuery(update.state);
    const readOnly = update.state.readOnly;
    const t = this.getTranslate();
    if (
      t === this.t &&
      query.eq(this.query) &&
      readOnly === this.readOnly &&
      !update.docChanged &&
      !update.selectionSet
    ) {
      return;
    }

    this.t = t;
    this.query = query;
    this.readOnly = readOnly;
    this.render();
  }

  destroy() {
    this.onOpenChange(false);
    queueMicrotask(() => this.root.unmount());
  }

  private updateQuery(update: Partial<SearchQuery>) {
    const current = getSearchQuery(this.view.state);
    this.view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          caseSensitive: current.caseSensitive,
          literal: current.literal,
          regexp: current.regexp,
          replace: current.replace,
          search: current.search,
          test: current.test,
          wholeWord: current.wholeWord,
          ...update,
        }),
      ),
    });
  }

  private render() {
    const matchPosition = this.getMatchPosition();

    this.root.render(
      <FileCodeSearchPanelContent
        t={this.t}
        matchPosition={matchPosition}
        onCaseSensitiveChange={(caseSensitive) =>
          this.updateQuery({ caseSensitive })
        }
        onClose={() => {
          closeSearchPanel(this.view);
          this.view.focus();
        }}
        onFindNext={() => findNext(this.view)}
        onFindPrevious={() => findPrevious(this.view)}
        onRegexpChange={(regexp) => this.updateQuery({ regexp })}
        onReplace={() => replaceNext(this.view)}
        onReplaceAll={() => replaceAll(this.view)}
        onReplaceChange={(replace) => this.updateQuery({ replace })}
        onSearchChange={(searchValue) =>
          this.updateQuery({ search: searchValue })
        }
        onSelectAll={() => selectMatches(this.view)}
        onWholeWordChange={(wholeWord) => this.updateQuery({ wholeWord })}
        query={this.query}
        readOnly={this.readOnly}
      />,
    );
  }

  private getMatchPosition() {
    if (!this.query.valid) {
      return null;
    }

    const selection = this.view.state.selection.main;
    const cursor = this.query.getCursor(this.view.state);
    let current = 0;
    let next = 0;
    let total = 0;

    for (let result = cursor.next(); !result.done; result = cursor.next()) {
      total += 1;
      const match = result.value;

      if (match.from === selection.from && match.to === selection.to) {
        current = total;
      }

      if (next === 0 && match.from >= selection.to) {
        next = total;
      }
    }

    return {
      current: current || next || (total > 0 ? 1 : 0),
      total,
    };
  }
}

export const createFileCodeSearchPanel = (
  view: EditorView,
  onOpenChange: (open: boolean) => void,
  getTranslate: () => Translate,
): Panel => new FileCodeSearchPanel(view, onOpenChange, getTranslate);
