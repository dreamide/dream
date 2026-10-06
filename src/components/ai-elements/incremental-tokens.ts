import type {
  CodeToTokensOptions,
  GrammarState,
  ThemedToken,
  TokensResult,
} from "shiki";

export const CODE_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

type CodeThemeName = (typeof CODE_THEMES)[keyof typeof CODE_THEMES];

// Structural, so tests can wrap a highlighter; generic over Shiki's language
// union so a typed HighlighterGeneric is accepted as-is.
type TokenSource<Lang extends string> = {
  codeToTokens: (
    code: string,
    options: CodeToTokensOptions<Lang, CodeThemeName>,
  ) => TokensResult;
};

// Languages without a TextMate grammar produce no grammar state to resume from.
const PLAIN_LANGUAGES = new Set(["text", "plaintext", "plain", "txt", "ansi"]);

const tokenize = <Lang extends string>(
  highlighter: TokenSource<Lang>,
  code: string,
  lang: Lang,
  grammarState?: GrammarState,
) =>
  highlighter.codeToTokens(code, {
    lang,
    themes: CODE_THEMES,
    ...(grammarState ? { grammarState } : {}),
  });

const toTokenized = (
  result: TokensResult,
  tokens = result.tokens,
): TokenizedCode => ({
  bg: result.bg ?? "transparent",
  fg: result.fg ?? "inherit",
  tokens,
});

export const tokenizeFull = <Lang extends string>(
  highlighter: TokenSource<Lang>,
  code: string,
  lang: Lang,
): TokenizedCode => toTokenized(tokenize(highlighter, code, lang));

/**
 * Tokenize a document that grows by appending, as a streamed code block does.
 *
 * Completed lines are tokenized once and kept with the grammar state after
 * them, so each update only re-tokenizes the newly completed lines plus the
 * unfinished last line. Multi-line strings, comments and embedded languages
 * continue exactly as they would in a full pass. Any input that is not an
 * extension of the previous one starts over from scratch.
 */
export const createIncrementalTokenizer = <Lang extends string>(
  highlighter: TokenSource<Lang>,
  lang: Lang,
) => {
  let committed:
    | {
        // Source up to and including the last completed line's "\n".
        prefix: string;
        lines: ThemedToken[][];
        state: GrammarState;
        result: TokensResult;
      }
    | undefined;

  return (code: string): TokenizedCode => {
    // A trailing "\r" may become "\r\n" in the next chunk, which would move a
    // line boundary we already committed. CRLF input takes the full path.
    if (PLAIN_LANGUAGES.has(lang) || code.includes("\r")) {
      committed = undefined;
      return tokenizeFull(highlighter, code, lang);
    }
    if (committed && !code.startsWith(committed.prefix)) {
      committed = undefined;
    }

    const completedEnd = code.lastIndexOf("\n") + 1;
    const committedEnd = committed?.prefix.length ?? 0;
    if (completedEnd > committedEnd) {
      // Leave out the final "\n": Shiki would emit an extra empty line and
      // advance the grammar state past it.
      const result = tokenize(
        highlighter,
        code.slice(committedEnd, completedEnd - 1),
        lang,
        committed?.state,
      );
      if (!result.grammarState) {
        committed = undefined;
        return tokenizeFull(highlighter, code, lang);
      }
      const lines = committed?.lines ?? [];
      for (const line of result.tokens) lines.push(line);
      committed = {
        lines,
        prefix: code.slice(0, completedEnd),
        result: committed?.result ?? result,
        state: result.grammarState,
      };
    }

    if (!committed) {
      return tokenizeFull(highlighter, code, lang);
    }

    const tail = tokenize(
      highlighter,
      code.slice(committed.prefix.length),
      lang,
      committed.state,
    );
    return toTokenized(committed.result, [...committed.lines, ...tail.tokens]);
  };
};
