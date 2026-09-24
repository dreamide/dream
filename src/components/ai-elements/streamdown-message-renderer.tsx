import { useMemo } from "react";
import remarkBreaks from "remark-breaks";
import {
  defaultRemarkPlugins,
  Streamdown,
  type StreamdownProps,
} from "streamdown";
import { StreamdownCodePre } from "@/components/ai-elements/streamdown-code-block";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";

const lineBreakRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

export type StreamdownMessageRendererProps = StreamdownProps & {
  /** Render single newlines as line breaks (for user-authored text). */
  lineBreaks?: boolean;
};

const StreamdownMessageRenderer = ({
  components,
  lineBreaks = false,
  ...props
}: StreamdownMessageRendererProps) => {
  const mergedComponents = useMemo(
    () => ({ pre: StreamdownCodePre, ...components }),
    [components],
  );

  return (
    <Streamdown
      components={mergedComponents}
      plugins={streamdownPlugins}
      {...(lineBreaks ? { remarkPlugins: lineBreakRemarkPlugins } : {})}
      {...props}
    />
  );
};

export default StreamdownMessageRenderer;
