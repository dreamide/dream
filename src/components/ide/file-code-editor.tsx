import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import {
  closeSearchPanel,
  getSearchQuery,
  openSearchPanel,
  SearchQuery,
  search,
  searchPanelOpen,
  setSearchQuery,
} from "@codemirror/search";
import CodeMirror, {
  EditorView,
  type Extension,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  type FileLineEnding,
  normalizeFileContentForEditor,
  serializeEditorContent,
} from "./file-buffers";
import { createFileCodeSearchPanel } from "./file-code-search-panel";

interface FileCodeEditorProps {
  disabled?: boolean;
  filePath: string;
  lineEnding: FileLineEnding;
  onChange: (value: string) => void;
  onSearchOpenChange: (open: boolean) => void;
  searchRequest: number;
  value: string;
  wordWrap?: boolean;
}

const fileEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background) !important",
    color: "var(--foreground)",
    fontSize: "12px",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    padding: "12px 0",
  },
  ".cm-activeLine": {
    backgroundColor:
      "color-mix(in oklab, var(--accent) 45%, transparent) !important",
  },
  ".cm-activeLineGutter": {
    backgroundColor:
      "color-mix(in oklab, var(--accent) 45%, transparent) !important",
  },
  ".cm-gutters": {
    backgroundColor: "var(--background) !important",
    borderRight: "0",
    color: "var(--muted-foreground)",
    minWidth: "48px",
    paddingLeft: "16px",
  },
  ".cm-line": {
    padding: "0 16px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    minWidth: "32px",
    padding: "0",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground":
    {
      backgroundColor: "var(--primary-selection) !important",
    },
  ".cm-content ::selection": {
    backgroundColor: "var(--primary-selection)",
  },
  ".cm-panels": {
    backgroundColor: "var(--background) !important",
    color: "var(--foreground)",
  },
  ".cm-panels-top": {
    borderBottom: "1px solid var(--border) !important",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.05)",
  },
  ".cm-panel.cm-search": {
    display: "block",
    padding: "0",
  },
  ".cm-panel.cm-search input, .cm-panel.cm-search button, .cm-panel.cm-search label":
    {
      margin: "0",
    },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in oklab, var(--primary) 22%, transparent)",
    outline: "1px solid color-mix(in oklab, var(--primary) 45%, transparent)",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "color-mix(in oklab, var(--primary) 40%, transparent)",
    outline: "1px solid var(--primary)",
  },
  ".cm-scroller": {
    backgroundColor: "var(--background)",
    fontFamily:
      'var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.5",
    overflow: "auto",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--popover) !important",
    border: "1px solid var(--border) !important",
    color: "var(--popover-foreground)",
  },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent) !important",
    color: "var(--accent-foreground) !important",
  },
});

const getLanguageExtension = (filePath: string): Extension | null => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";

  switch (extension) {
    case "cjs":
    case "js":
    case "mjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "cts":
    case "mts":
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "css":
      return css();
    case "htm":
    case "html":
      return html();
    case "md":
    case "markdown":
      return markdown();
    case "py":
    case "pyw":
      return python();
    default:
      return null;
  }
};

const FileCodeEditor = ({
  disabled = false,
  filePath,
  lineEnding,
  onChange,
  onSearchOpenChange,
  searchRequest,
  value,
  wordWrap = false,
}: FileCodeEditorProps) => {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const previousSearchRequestRef = useRef(searchRequest);
  const editorValue = useMemo(
    () => normalizeFileContentForEditor(value, lineEnding),
    [lineEnding, value],
  );
  const handleChange = useCallback(
    (content: string) => onChange(serializeEditorContent(content, lineEnding)),
    [lineEnding, onChange],
  );
  const extensions = useMemo(() => {
    const language = getLanguageExtension(filePath);
    return [
      fileEditorTheme,
      search({
        createPanel: (view) =>
          createFileCodeSearchPanel(view, onSearchOpenChange),
        top: true,
      }),
      EditorView.contentAttributes.of({ "aria-label": `Editing ${filePath}` }),
      ...(wordWrap ? [EditorView.lineWrapping] : []),
      ...(language ? [language] : []),
    ];
  }, [filePath, onSearchOpenChange, wordWrap]);

  useEffect(() => {
    if (previousSearchRequestRef.current === searchRequest) {
      return;
    }
    previousSearchRequestRef.current = searchRequest;

    const view = editorRef.current?.view;
    if (!view) {
      return;
    }

    if (searchPanelOpen(view.state)) {
      closeSearchPanel(view);
      view.focus();
    } else {
      openSearchPanel(view);
      const query = getSearchQuery(view.state);
      view.dispatch({
        effects: setSearchQuery.of(
          new SearchQuery({
            caseSensitive: query.caseSensitive,
            literal: query.literal,
            regexp: query.regexp,
            replace: "",
            search: "",
            wholeWord: query.wholeWord,
          }),
        ),
      });
    }
  }, [searchRequest]);

  return (
    <CodeMirror
      basicSetup={{
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: true,
        foldGutter: false,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        highlightSelectionMatches: true,
        lineNumbers: true,
      }}
      className="h-full overflow-hidden [&_.cm-editor]:h-full"
      editable={!disabled}
      extensions={extensions}
      height="100%"
      indentWithTab
      onChange={handleChange}
      readOnly={disabled}
      ref={editorRef}
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      value={editorValue}
    />
  );
};

export default FileCodeEditor;
