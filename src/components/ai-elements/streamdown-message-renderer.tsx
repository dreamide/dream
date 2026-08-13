import { useMemo } from "react";
import { Streamdown, type StreamdownProps } from "streamdown";
import { StreamdownCodePre } from "@/components/ai-elements/streamdown-code-block";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";

const StreamdownMessageRenderer = ({
  components,
  ...props
}: StreamdownProps) => {
  const mergedComponents = useMemo(
    () => ({ pre: StreamdownCodePre, ...components }),
    [components],
  );

  return (
    <Streamdown
      components={mergedComponents}
      plugins={streamdownPlugins}
      {...props}
    />
  );
};

export default StreamdownMessageRenderer;
