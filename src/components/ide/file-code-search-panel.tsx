import {
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
import type { KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toggle } from "@/components/ui/toggle";

interface FileCodeSearchPanelContentProps {
  onCaseSensitiveChange: (pressed: boolean) => void;
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
  onCaseSensitiveChange,
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
        <Input
          aria-invalid={query.search.length > 0 && !query.valid}
          aria-label="Find"
          autoComplete="off"
          className="h-8 min-w-32 flex-1 font-mono text-xs text-foreground md:text-xs dark:bg-surface-950"
          onChange={(event) => onSearchChange(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Find"
          ref={(element) => element?.setAttribute("main-field", "true")}
          spellCheck={false}
          value={query.search}
        />
        <Button
          aria-label="Previous match"
          disabled={!query.valid}
          onClick={onFindPrevious}
          size="icon-sm"
          title="Previous match"
          type="button"
          variant="ghost"
        >
          <ChevronUp />
        </Button>
        <Button
          aria-label="Next match"
          disabled={!query.valid}
          onClick={onFindNext}
          size="icon-sm"
          title="Next match"
          type="button"
          variant="ghost"
        >
          <ChevronDown />
        </Button>
        <Button
          aria-label="Select all matches"
          disabled={!query.valid}
          onClick={onSelectAll}
          size="icon-sm"
          title="Select all matches"
          type="button"
          variant="ghost"
        >
          <ListChecks />
        </Button>
        <div className="mx-0.5 h-5 w-px shrink-0 bg-border" />
        <Toggle
          aria-label="Match case"
          onPressedChange={onCaseSensitiveChange}
          pressed={query.caseSensitive}
          size="sm"
          title="Match case"
        >
          <CaseSensitive />
        </Toggle>
        <Toggle
          aria-label="Use regular expression"
          onPressedChange={onRegexpChange}
          pressed={query.regexp}
          size="sm"
          title="Use regular expression"
        >
          <RegexIcon />
        </Toggle>
        <Toggle
          aria-label="Match whole word"
          onPressedChange={onWholeWordChange}
          pressed={query.wholeWord}
          size="sm"
          title="Match whole word"
        >
          <WholeWord />
        </Toggle>
      </div>

      {!readOnly ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <Input
            aria-label="Replace"
            autoComplete="off"
            className="h-8 min-w-32 flex-1 font-mono text-xs text-foreground md:text-xs dark:bg-surface-950"
            onChange={(event) => onReplaceChange(event.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="Replace"
            spellCheck={false}
            value={query.replace}
          />
          <Button
            className="text-xs"
            disabled={!query.valid}
            onClick={onReplace}
            size="sm"
            title="Replace current match"
            type="button"
            variant="outline"
          >
            <ReplaceIcon />
            Replace
          </Button>
          <Button
            className="text-xs"
            disabled={!query.valid}
            onClick={onReplaceAll}
            size="sm"
            title="Replace all matches"
            type="button"
            variant="outline"
          >
            <ReplaceAllIcon />
            Replace all
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
  private query: SearchQuery;
  private readOnly: boolean;
  private view: EditorView;

  constructor(view: EditorView, onOpenChange: (open: boolean) => void) {
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
  }

  update(update: ViewUpdate) {
    this.view = update.view;
    const query = getSearchQuery(update.state);
    const readOnly = update.state.readOnly;
    if (query.eq(this.query) && readOnly === this.readOnly) {
      return;
    }

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
    this.root.render(
      <FileCodeSearchPanelContent
        onCaseSensitiveChange={(caseSensitive) =>
          this.updateQuery({ caseSensitive })
        }
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
}

export const createFileCodeSearchPanel = (
  view: EditorView,
  onOpenChange: (open: boolean) => void,
): Panel => new FileCodeSearchPanel(view, onOpenChange);
