import type { CustomRendererProps } from "streamdown";
import { bundledLanguages } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockDownloadButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
  resolveBundledLanguage,
} from "@/components/ai-elements/code-block";

const codeFenceLanguageMarkers = new Set([
  "text",
  "txt",
  "plaintext",
  "plain",
  "console",
  "shell-session",
  "output",
  "log",
  ...Object.keys(bundledLanguages).filter((language) => language !== "mermaid"),
]);

export const normalizeCodeFenceLanguageMarkers = (markdown: string) =>
  markdown.replace(
    /(^|\n)(`{3,}|~{3,})[ \t]*\n([A-Za-z0-9_+#.-]+)[ \t]*\n([\s\S]*?)(\n\2[ \t]*(?=\n|$))/g,
    (match, prefix, fence, languageMarker, code, closing) => {
      const language = languageMarker.toLowerCase();
      if (!codeFenceLanguageMarkers.has(language)) {
        return match;
      }

      return `${prefix}${fence}${languageMarker}\n${code}${closing}`;
    },
  );

const inferLanguageFromFirstLine = (code: string, language: string) => {
  const displayLanguage = language.trim().toLowerCase();
  if (displayLanguage) {
    return { code, language: displayLanguage };
  }

  const newlineIndex = code.indexOf("\n");
  if (newlineIndex === -1) {
    return { code, language: "" };
  }

  const firstLine = code.slice(0, newlineIndex).trim().toLowerCase();
  if (!firstLine || firstLine.includes(" ")) {
    return { code, language: "" };
  }

  if (!codeFenceLanguageMarkers.has(firstLine)) {
    return { code, language: "" };
  }

  return {
    code: code.slice(newlineIndex + 1),
    language: firstLine,
  };
};

export const StreamdownCodeBlock = ({
  code,
  language,
}: Pick<CustomRendererProps, "code" | "language">) => {
  const normalized = inferLanguageFromFirstLine(code, language);
  const displayLanguage = normalized.language;
  const highlightLanguage = displayLanguage || "text";

  return (
    <CodeBlock
      className="my-4 [&_pre]:py-2"
      code={normalized.code}
      language={resolveBundledLanguage(highlightLanguage)}
      showLineNumbers
      style={{ contentVisibility: "visible" }}
    >
      <CodeBlockHeader className="min-h-8 px-2.5 py-1">
        {displayLanguage ? (
          <CodeBlockTitle>
            <CodeBlockFilename>{displayLanguage}</CodeBlockFilename>
          </CodeBlockTitle>
        ) : (
          <span />
        )}
        <CodeBlockActions>
          <CodeBlockDownloadButton
            className="h-7 w-7 [&_svg]:size-3.5"
            language={highlightLanguage}
          />
          <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3.5" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
};
