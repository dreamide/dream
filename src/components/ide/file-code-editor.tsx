import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { openSearchPanel } from "@codemirror/search";
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

interface FileCodeEditorProps {
  disabled?: boolean;
  filePath: string;
  lineEnding: FileLineEnding;
  onChange: (value: string) => void;
  searchRequest: number;
  value: string;
}

const fileEditorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--background)",
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
  ".cm-gutters": {
    backgroundColor: "var(--background)",
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
  ".cm-scroller": {
    fontFamily:
      'var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    lineHeight: "1.5",
    overflow: "auto",
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
  searchRequest,
  value,
}: FileCodeEditorProps) => {
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<ReactCodeMirrorRef>(null);
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
      EditorView.contentAttributes.of({ "aria-label": `Editing ${filePath}` }),
      ...(language ? [language] : []),
    ];
  }, [filePath]);

  useEffect(() => {
    if (searchRequest > 0 && editorRef.current?.view) {
      openSearchPanel(editorRef.current.view);
      editorRef.current.view.focus();
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
