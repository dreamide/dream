import { performance } from "node:perf_hooks";
import { createHighlighter } from "shiki";
import {
  CODE_THEMES,
  createIncrementalTokenizer,
  tokenizeFull,
} from "../src/components/ai-elements/incremental-tokens";

const highlighter = await createHighlighter({
  themes: Object.values(CODE_THEMES),
  langs: ["typescript"],
});
try {
  const code = Array.from(
    { length: 300 },
    (_, i) => `export const value${i} = ${i};\n`,
  ).join("");
  const prefixes = Array.from({ length: Math.ceil(code.length / 80) }, (_, i) =>
    code.slice(0, (i + 1) * 80),
  );
  const run = (tokenize: (text: string) => unknown) => {
    const start = performance.now();
    for (const prefix of prefixes) tokenize(prefix);
    return Math.round((performance.now() - start) * 100) / 100;
  };
  tokenizeFull(highlighter, code, "typescript");
  const fullMs = run((prefix) =>
    tokenizeFull(highlighter, prefix, "typescript"),
  );
  const incrementalMs = run(
    createIncrementalTokenizer(highlighter, "typescript"),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        bytes: Buffer.byteLength(code),
        lines: 300,
        chunkCharacters: 80,
        updates: prefixes.length,
        fullMs,
        incrementalMs,
      },
      null,
      2,
    ),
  );
} finally {
  highlighter.dispose();
}
