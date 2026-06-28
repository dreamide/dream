import type { CustomRendererProps } from "streamdown";
import type { ComponentProps, ReactElement } from "react";
import { cloneElement, isValidElement } from "react";
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

const codeFenceLanguageRegex = /(?:^|\s)language-([^\s]+)/;

const getTextContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(getTextContent).join("");
  }

  if (isValidElement<{ children?: unknown }>(value)) {
    return getTextContent(value.props.children);
  }

  return "";
};

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
  const trimmedCode = code
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .replace(/(?:\r?\n[ \t]*)+$/, "");
  const displayLanguage = language.trim().toLowerCase();
  if (displayLanguage) {
    return { code: trimmedCode, language: displayLanguage };
  }

  const newlineIndex = trimmedCode.indexOf("\n");
  if (newlineIndex === -1) {
    return { code: trimmedCode, language: "" };
  }

  const firstLine = trimmedCode.slice(0, newlineIndex).trim().toLowerCase();
  if (!firstLine || firstLine.includes(" ")) {
    return { code: trimmedCode, language: "" };
  }

  if (!codeFenceLanguageMarkers.has(firstLine)) {
    return { code: trimmedCode, language: "" };
  }

  return {
    code: trimmedCode.slice(newlineIndex + 1),
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
      className="my-3 [&_pre]:py-2"
      code={normalized.code}
      language={resolveBundledLanguage(highlightLanguage)}
      showLineNumbers
      style={{ contentVisibility: "visible" }}
    >
      <CodeBlockHeader className="min-h-7 px-2.5 py-0.5">
        {displayLanguage ? (
          <CodeBlockTitle>
            <CodeBlockFilename>{displayLanguage}</CodeBlockFilename>
          </CodeBlockTitle>
        ) : (
          <span />
        )}
        <CodeBlockActions>
          <CodeBlockDownloadButton
            className="h-7 w-7 [&_svg]:size-3"
            language={highlightLanguage}
          />
          <CodeBlockCopyButton className="h-7 w-7 [&_svg]:size-3" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
};

export const StreamdownCodePre = ({ children }: ComponentProps<"pre">) => {
  if (!isValidElement(children)) {
    return <pre>{children}</pre>;
  }

  const codeElement = children as ReactElement<{
    children?: unknown;
    className?: string;
  }>;
  const languageMatch = codeElement.props.className?.match(
    codeFenceLanguageRegex,
  );

  if (!languageMatch) {
    return (
      <StreamdownCodeBlock
        code={getTextContent(codeElement.props.children)}
        language=""
      />
    );
  }

  return cloneElement(codeElement, {
    "data-block": "true",
  } as Partial<typeof codeElement.props>);
};
