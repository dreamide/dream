import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import type { ComponentProps } from "react";
import { bundledLanguages } from "shiki";
import { Streamdown } from "streamdown";
import { StreamdownCodeBlock } from "@/components/ai-elements/streamdown-code-block";

const streamdownCodeRendererLanguages = [
  "text",
  "txt",
  "plaintext",
  "plain",
  "console",
  "shell-session",
  "output",
  "log",
  ...Object.keys(bundledLanguages).filter((language) => language !== "mermaid"),
];

export const streamdownPlugins = {
  cjk,
  code,
  math,
  mermaid,
  renderers: [
    {
      component: StreamdownCodeBlock,
      language: streamdownCodeRendererLanguages,
    },
  ],
} as ComponentProps<typeof Streamdown>["plugins"];
