import { cjk } from "@streamdown/cjk";
import { type ComponentProps, useEffect, useState } from "react";
import type { Streamdown } from "streamdown";
import { streamdownCodeRendererLanguages } from "@/components/ai-elements/code-languages";
import { StreamdownCodeBlock } from "@/components/ai-elements/streamdown-code-block";

type StreamdownPlugins = NonNullable<
  ComponentProps<typeof Streamdown>["plugins"]
>;

const BASE_RENDERERS: StreamdownPlugins["renderers"] = [
  {
    component: StreamdownCodeBlock,
    language: streamdownCodeRendererLanguages,
  },
];

// Keep the default plugin surface free of Mermaid (diagram engine) and KaTeX
// (math renderer) until a message actually uses them.
export const streamdownPlugins: StreamdownPlugins = {
  cjk,
  renderers: BASE_RENDERERS,
};

const MERMAID_FENCE_PATTERN = /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*mermaid\b/i;
const MATH_DELIMITER_PATTERN = /\$\$|\\\[|\\\(/;

let loadedMathPlugin: StreamdownPlugins["math"] | null = null;
let mathPluginPromise: Promise<StreamdownPlugins["math"]> | null = null;
let loadedMermaidPlugin: StreamdownPlugins["mermaid"] | null = null;
let mermaidPluginPromise: Promise<StreamdownPlugins["mermaid"]> | null = null;

// Cache composed plugin objects by (hasMath, hasMermaid) so Streamdown receives
// a stable object reference and keeps hitting its unified processor cache.
const composedPluginsCache = new Map<string, StreamdownPlugins>();

const getComposedPlugins = (
  includeMath: boolean,
  includeMermaid: boolean,
): StreamdownPlugins => {
  const math = includeMath ? loadedMathPlugin : null;
  const mermaid = includeMermaid ? loadedMermaidPlugin : null;
  if (!math && !mermaid) {
    return streamdownPlugins;
  }

  const key = `${math ? "m" : ""}:${mermaid ? "d" : ""}`;
  let cached = composedPluginsCache.get(key);
  if (!cached) {
    cached = {
      cjk,
      ...(math ? { math } : {}),
      ...(mermaid ? { mermaid } : {}),
      renderers: BASE_RENDERERS,
    };
    composedPluginsCache.set(key, cached);
  }
  return cached;
};

const loadMathPlugin = () => {
  if (!mathPluginPromise) {
    mathPluginPromise = import("@streamdown/math").then((module) => {
      loadedMathPlugin = module.math;
      return module.math;
    });
  }
  return mathPluginPromise;
};

const loadMermaidPlugin = () => {
  if (!mermaidPluginPromise) {
    mermaidPluginPromise = import("@streamdown/mermaid").then((module) => {
      loadedMermaidPlugin = module.mermaid;
      return module.mermaid;
    });
  }
  return mermaidPluginPromise;
};

export const useStreamdownPlugins = (content: unknown): StreamdownPlugins => {
  const text = typeof content === "string" ? content : "";
  const needsMath = text.length > 0 && MATH_DELIMITER_PATTERN.test(text);
  const needsMermaid = text.length > 0 && MERMAID_FENCE_PATTERN.test(text);

  const [mathReady, setMathReady] = useState(loadedMathPlugin !== null);
  const [mermaidReady, setMermaidReady] = useState(
    loadedMermaidPlugin !== null,
  );

  useEffect(() => {
    if (!needsMath || loadedMathPlugin !== null) {
      return;
    }
    let cancelled = false;
    void loadMathPlugin().then(() => {
      if (!cancelled) {
        setMathReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsMath]);

  useEffect(() => {
    if (!needsMermaid || loadedMermaidPlugin !== null) {
      return;
    }
    let cancelled = false;
    void loadMermaidPlugin().then(() => {
      if (!cancelled) {
        setMermaidReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [needsMermaid]);

  return getComposedPlugins(
    needsMath && mathReady,
    needsMermaid && mermaidReady,
  );
};
