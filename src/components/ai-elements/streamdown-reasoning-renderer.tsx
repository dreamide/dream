import { Streamdown, type StreamdownProps } from "streamdown";
import { StreamdownCodePre } from "@/components/ai-elements/streamdown-code-block";
import { useStreamdownPlugins } from "@/components/ai-elements/streamdown-plugins";

const reasoningMarkdownComponents = {
  pre: StreamdownCodePre,
} as NonNullable<StreamdownProps["components"]>;

const StreamdownReasoningRenderer = (props: StreamdownProps) => {
  const plugins = useStreamdownPlugins(props.children);

  return (
    <Streamdown
      components={reasoningMarkdownComponents}
      plugins={plugins}
      {...props}
    />
  );
};

export default StreamdownReasoningRenderer;
