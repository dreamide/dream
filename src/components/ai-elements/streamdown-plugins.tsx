import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import type { Streamdown } from "streamdown";
import { streamdownCodeRendererLanguages } from "@/components/ai-elements/code-languages";
import { StreamdownCodeBlock } from "@/components/ai-elements/streamdown-code-block";

export const streamdownPlugins = {
  cjk,
  math,
  mermaid,
  renderers: [
    {
      component: StreamdownCodeBlock,
      language: streamdownCodeRendererLanguages,
    },
  ],
} as ComponentProps<typeof Streamdown>["plugins"];
