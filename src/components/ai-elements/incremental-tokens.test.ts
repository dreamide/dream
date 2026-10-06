import {
  createHighlighter,
  type HighlighterGeneric,
  type ThemedToken,
} from "shiki";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CODE_THEMES,
  createIncrementalTokenizer,
  tokenizeFull,
} from "./incremental-tokens";

// biome-ignore lint/suspicious/noExplicitAny: test highlighter
let highlighter: HighlighterGeneric<any, any>;

beforeAll(async () => {
  highlighter = await createHighlighter({
    langs: ["tsx", "python", "markdown"],
    themes: [CODE_THEMES.light, CODE_THEMES.dark],
  });
});

const comparable = (tokens: ThemedToken[][]) =>
  tokens.map((line) =>
    line.map(({ color, content, fontStyle, htmlStyle }) =>
      JSON.stringify({ color, content, fontStyle, htmlStyle }),
    ),
  );

// Multi-line constructs are where resuming from grammar state matters: a
// tokenizer that restarted per chunk would colour these lines as plain code.
const SAMPLES = {
  tsx: [
    "/**",
    " * A block comment spanning",
    " * several lines.",
    " */",
    "const template = `first line",
    "${value} second line",
    "third line`;",
    "",
    "export const App = () => (",
    '  <div className="app">',
    "    {items.map((item) => <Item key={item.id} {...item} />)}",
    "  </div>",
    ");",
    "",
  ].join("\n"),
  python: [
    'def greet(name: str) -> str:',
    '    """Docstring that',
    '    spans lines."""',
    '    return f"hello {name}"',
  ].join("\n"),
  markdown: [
    "# Title",
    "",
    "```ts",
    "const embedded = 1;",
    "```",
    "",
    "- item",
  ].join("\n"),
} as const;

describe("createIncrementalTokenizer", () => {
  for (const [lang, sample] of Object.entries(SAMPLES)) {
    it(`matches a full tokenize at every streamed prefix (${lang})`, () => {
      const tokenize = createIncrementalTokenizer(highlighter, lang);
      for (let end = 0; end <= sample.length; end += 7) {
        const code = sample.slice(0, end);
        expect(comparable(tokenize(code).tokens)).toEqual(
          comparable(tokenizeFull(highlighter, code, lang).tokens),
        );
      }
      expect(comparable(tokenize(sample).tokens)).toEqual(
        comparable(tokenizeFull(highlighter, sample, lang).tokens),
      );
    });
  }

  it("only tokenizes the new tail when the code grows", () => {
    let tokenizedChars = 0;
    const counting = {
      codeToTokens: ((code: string, options: never) => {
        tokenizedChars += code.length;
        return highlighter.codeToTokens(code, options);
      }) as typeof highlighter.codeToTokens,
    };
    const tokenize = createIncrementalTokenizer(counting, "tsx");
    const lines = SAMPLES.tsx.split("\n");
    for (let count = 1; count <= lines.length; count += 1) {
      tokenize(lines.slice(0, count).join("\n"));
    }
    // A full re-tokenize per update would cost roughly length * lines / 2.
    expect(tokenizedChars).toBeLessThan(SAMPLES.tsx.length * 3);
  });

  it("starts over when the code is replaced rather than extended", () => {
    const tokenize = createIncrementalTokenizer(highlighter, "tsx");
    tokenize("/* open comment\nstill comment\n");
    const replaced = "const a = 1;\nconst b = 2;";
    expect(comparable(tokenize(replaced).tokens)).toEqual(
      comparable(tokenizeFull(highlighter, replaced, "tsx").tokens),
    );
  });

  it("handles CRLF input by falling back to a full tokenize", () => {
    const tokenize = createIncrementalTokenizer(highlighter, "tsx");
    const code = "const a = 1;\r\nconst b = `x\r\ny`;\r\n";
    expect(comparable(tokenize(code).tokens)).toEqual(
      comparable(tokenizeFull(highlighter, code, "tsx").tokens),
    );
  });
});
