import type { CustomRendererProps } from "streamdown";
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

export const StreamdownCodeBlock = ({
  code,
  language,
}: Pick<CustomRendererProps, "code" | "language">) => {
  const displayLanguage = language.trim().toLowerCase();
  const highlightLanguage = displayLanguage || "text";

  return (
    <CodeBlock
      className="my-4 [&_pre]:py-2"
      code={code}
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
