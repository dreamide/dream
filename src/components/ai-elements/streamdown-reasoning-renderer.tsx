import { Streamdown, type StreamdownProps } from "streamdown";
import { StreamdownCodePre } from "@/components/ai-elements/streamdown-code-block";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";

const reasoningMarkdownComponents = {
  pre: StreamdownCodePre,
} as NonNullable<StreamdownProps["components"]>;

const StreamdownReasoningRenderer = (props: StreamdownProps) => (
  <Streamdown
    components={reasoningMarkdownComponents}
    plugins={streamdownPlugins}
    {...props}
  />
);

export default StreamdownReasoningRenderer;
