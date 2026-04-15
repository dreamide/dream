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
}: CustomRendererProps) => {
  const normalizedLanguage = language.trim().toLowerCase() || "text";

  return (
    <CodeBlock
      className="my-4"
      code={code}
      language={resolveBundledLanguage(normalizedLanguage)}
      showLineNumbers
    >
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockFilename>{normalizedLanguage}</CodeBlockFilename>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockDownloadButton language={normalizedLanguage} />
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
};
