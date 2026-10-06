import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { BundledLanguage, ThemedToken } from "shiki";
import { normalizeCodeLanguage } from "@/components/ai-elements/code-languages";
import {
  createIncrementalTokenizer,
  type TokenizedCode,
} from "@/components/ai-elements/incremental-tokens";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// biome-ignore lint/suspicious/noBitwiseOperators: shiki bitflag check
// eslint-disable-next-line no-bitwise -- shiki bitflag check
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// biome-ignore lint/suspicious/noBitwiseOperators: shiki bitflag check
// eslint-disable-next-line no-bitwise -- shiki bitflag check
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
  // biome-ignore lint/suspicious/noBitwiseOperators: shiki bitflag check
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4;

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
  token: ThemedToken;
  key: string;
}
interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

export interface CodeSearchMatch {
  end: number;
  index: number;
  lineIndex: number;
  start: number;
}

export const findCodeSearchMatches = (
  code: string,
  query: string,
): CodeSearchMatch[] => {
  if (!query) {
    return [];
  }

  const normalizedQuery = query.toLocaleLowerCase();
  const matches: CodeSearchMatch[] = [];

  for (const [lineIndex, line] of code.split(/\r?\n/).entries()) {
    const normalizedLine = line.toLocaleLowerCase();
    let start = 0;

    while (start <= normalizedLine.length - normalizedQuery.length) {
      const matchStart = normalizedLine.indexOf(normalizedQuery, start);
      if (matchStart === -1) {
        break;
      }

      matches.push({
        end: matchStart + query.length,
        index: matches.length,
        lineIndex,
        start: matchStart,
      });
      start = matchStart + Math.max(query.length, 1);
    }
  }

  return matches;
};

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }));

interface TokenSearchSegment {
  key: string;
  matchIndex: number | null;
  text: string;
}

const getTokenSearchSegments = (
  content: string,
  tokenOffset: number,
  lineMatches: CodeSearchMatch[],
): TokenSearchSegment[] => {
  const tokenEnd = tokenOffset + content.length;
  const segments: TokenSearchSegment[] = [];
  let cursor = 0;

  for (const match of lineMatches) {
    const overlapStart = Math.max(match.start, tokenOffset);
    const overlapEnd = Math.min(match.end, tokenEnd);
    if (overlapStart >= overlapEnd) {
      continue;
    }

    const localStart = overlapStart - tokenOffset;
    const localEnd = overlapEnd - tokenOffset;
    if (localStart > cursor) {
      segments.push({
        key: `text-${cursor}`,
        matchIndex: null,
        text: content.slice(cursor, localStart),
      });
    }

    segments.push({
      key: `match-${match.index}-${localStart}`,
      matchIndex: match.index,
      text: content.slice(localStart, localEnd),
    });
    cursor = localEnd;
  }

  if (cursor < content.length) {
    segments.push({
      key: `text-${cursor}`,
      matchIndex: null,
      text: content.slice(cursor),
    });
  }

  return segments;
};

// Token rendering component
const TokenSpan = ({
  activeSearchMatchIndex,
  lineMatches,
  token,
  tokenOffset,
}: {
  activeSearchMatchIndex: number;
  lineMatches: CodeSearchMatch[];
  token: ThemedToken;
  tokenOffset: number;
}) => {
  const segments =
    lineMatches.length > 0
      ? getTokenSearchSegments(token.content, tokenOffset, lineMatches)
      : [];

  return (
    <span
      className="dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)]"
      style={
        {
          backgroundColor: token.bgColor,
          color: token.color,
          fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
          fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
          textDecoration: isUnderline(token.fontStyle)
            ? "underline"
            : undefined,
          ...token.htmlStyle,
        } as CSSProperties
      }
    >
      {segments.length > 0
        ? segments.map((segment) =>
            segment.matchIndex === null ? (
              <span key={segment.key}>{segment.text}</span>
            ) : (
              <mark
                className={cn(
                  "rounded-[1px] bg-amber-300/70 text-inherit dark:bg-amber-400/40",
                  segment.matchIndex === activeSearchMatchIndex &&
                    "bg-orange-400/80 outline outline-1 outline-orange-500 dark:bg-orange-400/65",
                )}
                data-code-search-match={segment.matchIndex}
                key={segment.key}
              >
                {segment.text}
              </mark>
            ),
          )
        : token.content}
    </span>
  );
};

// Line rendering component
const LineSpan = ({
  activeSearchMatchIndex,
  keyedLine,
  lineMatches,
  lineNumber,
  showLineNumbers,
}: {
  activeSearchMatchIndex: number;
  keyedLine: KeyedLine;
  lineMatches: CodeSearchMatch[];
  lineNumber: number;
  showLineNumbers: boolean;
}) => {
  let tokenOffset = 0;
  const lineContent =
    keyedLine.tokens.length === 0
      ? " "
      : keyedLine.tokens.map(({ token, key }) => {
          const currentTokenOffset = tokenOffset;
          tokenOffset += token.content.length;
          return (
            <TokenSpan
              activeSearchMatchIndex={activeSearchMatchIndex}
              key={key}
              lineMatches={lineMatches}
              token={token}
              tokenOffset={currentTokenOffset}
            />
          );
        });

  if (!showLineNumbers) {
    return <span className="block min-h-[1.5em]">{lineContent}</span>;
  }

  return (
    <span className={LINE_NUMBER_CLASSES}>
      <span className="select-none text-right font-mono text-surface-500 dark:text-surface-400 tabular-nums">
        {lineNumber}
      </span>
      <span className="min-w-0">{lineContent}</span>
    </span>
  );
};

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  activeSearchMatchIndex?: number;
  code: string;
  deferUntilHighlighted?: boolean;
  language: BundledLanguage;
  searchQuery?: string;
  showLineNumbers?: boolean;
  startingLineNumber?: number;
  wordWrap?: boolean;
};

interface CodeBlockContextType {
  code: string;
}

const CODE_BLOCK_DOWNLOAD_EXTENSIONS: Record<string, string> = {
  bash: "sh",
  html: "html",
  javascript: "js",
  js: "js",
  json: "json",
  markdown: "md",
  md: "md",
  mdx: "mdx",
  plaintext: "txt",
  python: "py",
  shell: "sh",
  text: "txt",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  xml: "xml",
  yaml: "yaml",
  yml: "yml",
};

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

type CodeHighlighter = Awaited<
  ReturnType<
    typeof import("@/components/ai-elements/shiki-highlighter").getCodeHighlighter
  >
>;

// Shiki's singleton highlighter, once loaded, plus the languages it can
// tokenize. Lets a remounted block highlight synchronously on first render.
let loadedHighlighter: CodeHighlighter | null = null;
const loadedLanguages = new Set<string>();

const loadHighlighter = async (language: BundledLanguage) => {
  const { getCodeHighlighter } = await import(
    "@/components/ai-elements/shiki-highlighter"
  );
  const highlighter = await getCodeHighlighter(language);
  loadedHighlighter = highlighter;
  loadedLanguages.add(language);
  return highlighter;
};

const getLoadedHighlighter = (language: BundledLanguage) =>
  loadedLanguages.has(language) ? loadedHighlighter : null;

const copyTextToClipboard = async (value: string) => {
  const desktopApi = getDesktopApi();
  if (desktopApi) {
    const copied = await desktopApi.writeClipboardText(value);
    if (!copied) {
      throw new Error("Clipboard copy failed");
    }
    return;
  }

  if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
    throw new Error("Clipboard API not available");
  }

  await navigator.clipboard.writeText(value);
};

const downloadTextFile = async (
  filename: string,
  contents: string,
  dialogTitle: string,
) => {
  const desktopApi = getDesktopApi();
  if (desktopApi) {
    await desktopApi.saveTextFile({
      contents,
      defaultPath: filename,
      title: dialogTitle,
    });
    return;
  }

  const blob = new Blob([contents], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const resolveBundledLanguage = (language: string): BundledLanguage => {
  return normalizeCodeLanguage(language) as BundledLanguage;
};

const getCodeBlockDownloadFilename = (language: string) => {
  const normalized = language.trim().toLowerCase();
  const extension = CODE_BLOCK_DOWNLOAD_EXTENSIONS[normalized] || "txt";
  return `file.${extension}`;
};

// Finished results, so remounting a block (switching chats, scrolling a
// virtualized list) does not tokenize it again. Bounded by total source size.
const TOKENS_CACHE_MAX_CHARS = 2_000_000;
const tokensCache = new Map<string, TokenizedCode>();
let tokensCacheChars = 0;

// Language ids never contain ":", so full-source keys cannot collide.
const getTokensCacheKey = (code: string, language: string) =>
  `${language}:${code}`;

const deleteCachedTokens = (key: string) => {
  if (tokensCache.delete(key)) {
    tokensCacheChars -= key.length;
  }
};

const getCachedTokens = (key: string) => {
  const cached = tokensCache.get(key);
  if (cached) {
    // Refresh recency: Map iteration order is insertion order.
    tokensCache.delete(key);
    tokensCache.set(key, cached);
  }
  return cached;
};

const setCachedTokens = (key: string, tokenized: TokenizedCode) => {
  if (key.length > TOKENS_CACHE_MAX_CHARS) return;
  deleteCachedTokens(key);
  tokensCache.set(key, tokenized);
  tokensCacheChars += key.length;
  for (const oldestKey of tokensCache.keys()) {
    if (tokensCacheChars <= TOKENS_CACHE_MAX_CHARS) break;
    deleteCachedTokens(oldestKey);
  }
};

// Create raw tokens for immediate display while highlighting loads
const createRawTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split(/\n/).map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

/**
 * Highlight `code`, re-tokenizing only what changed while it streams in.
 * Returns null until the highlighter has loaded (or failed to).
 */
const useHighlightedTokens = (
  code: string,
  language: BundledLanguage,
): TokenizedCode | null => {
  // Loading only ever adds languages, so reading it during render is stable;
  // the reducer just re-renders once this block's language has loaded.
  const highlighter = getLoadedHighlighter(language);
  const [, onLoaded] = useReducer((count: number) => count + 1, 0);
  const [failedLanguage, setFailedLanguage] = useState<string | null>(null);

  useEffect(() => {
    if (getLoadedHighlighter(language)) return;
    let cancelled = false;
    loadHighlighter(language).then(
      () => {
        if (!cancelled) onLoaded();
      },
      (error: unknown) => {
        console.error("Failed to highlight code:", error);
        if (!cancelled) setFailedLanguage(language);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [language]);

  // One tokenizer per block and language: it keeps the grammar state of the
  // lines it has already seen, so a streamed block grows in O(new text).
  const tokenize = useMemo(
    () =>
      highlighter ? createIncrementalTokenizer(highlighter, language) : null,
    [highlighter, language],
  );

  const cacheKey = getTokensCacheKey(code, language);
  const tokenized = useMemo(() => {
    const cached = getCachedTokens(cacheKey);
    if (cached) return cached;
    if (failedLanguage === language) return createRawTokens(code);
    if (!tokenize) return null;
    try {
      return tokenize(code);
    } catch (error) {
      console.error("Failed to highlight code:", error);
      return createRawTokens(code);
    }
  }, [cacheKey, code, failedLanguage, language, tokenize]);

  // While a block streams, each version extends the last. Replace this
  // block's previous entry instead of caching every partial version.
  const cachedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tokenize || !tokenized) return;
    const previousKey = cachedKeyRef.current;
    if (
      previousKey &&
      previousKey !== cacheKey &&
      cacheKey.startsWith(previousKey)
    ) {
      deleteCachedTokens(previousKey);
    }
    setCachedTokens(cacheKey, tokenized);
    cachedKeyRef.current = cacheKey;
  }, [cacheKey, tokenize, tokenized]);

  return tokenized;
};

// Keep line numbers as real text so the gutter cannot disappear if counters or
// pseudo-element styles are overridden by surrounding markdown/code CSS.
const LINE_NUMBER_CLASSES = cn(
  "grid",
  "min-h-[1.5em]",
  "grid-cols-[2rem_minmax(0,1fr)]",
  "gap-4",
);

const CodeBlockBody = memo(
  ({
    activeSearchMatchIndex,
    searchMatches,
    tokenized,
    showLineNumbers,
    startingLineNumber,
    wordWrap = false,
    className,
  }: {
    activeSearchMatchIndex: number;
    searchMatches: CodeSearchMatch[];
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    startingLineNumber: number;
    wordWrap?: boolean;
    className?: string;
  }) => {
    const preStyle = useMemo(
      () => ({
        backgroundColor: tokenized.bg,
        color: tokenized.fg,
      }),
      [tokenized.bg, tokenized.fg],
    );

    const keyedLines = useMemo(
      () => addKeysToTokens(tokenized.tokens),
      [tokenized.tokens],
    );
    const searchMatchesByLine = useMemo(() => {
      const grouped = new Map<number, CodeSearchMatch[]>();
      for (const match of searchMatches) {
        const lineMatches = grouped.get(match.lineIndex) ?? [];
        lineMatches.push(match);
        grouped.set(match.lineIndex, lineMatches);
      }
      return grouped;
    }, [searchMatches]);

    return (
        <pre
          className={cn(
            "dark:!bg-[var(--shiki-dark-bg)] dark:!text-[var(--shiki-dark)] m-0 px-4 py-3 !text-[12px]",
            wordWrap && "whitespace-pre-wrap break-words",
            className,
          )}
        style={preStyle}
      >
        <code className={cn("font-mono !text-[12px]")}>
          {keyedLines.map((keyedLine, lineIndex) => (
            <LineSpan
              activeSearchMatchIndex={activeSearchMatchIndex}
              key={keyedLine.key}
              keyedLine={keyedLine}
              lineMatches={searchMatchesByLine.get(lineIndex) ?? []}
              lineNumber={startingLineNumber + lineIndex}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.activeSearchMatchIndex === nextProps.activeSearchMatchIndex &&
    prevProps.searchMatches === nextProps.searchMatches &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.startingLineNumber === nextProps.startingLineNumber &&
    prevProps.wordWrap === nextProps.wordWrap &&
    prevProps.className === nextProps.className,
);

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-md border bg-background text-foreground",
      className,
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
    <div
      className={cn(
        "flex min-h-9 items-center justify-between px-3 py-1.5 text-muted-foreground text-[12px]",
        className,
      )}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("-mr-1 flex items-center gap-1.5", className)}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockContent = ({
  activeSearchMatchIndex = -1,
  code,
  deferUntilHighlighted = false,
  language,
  searchQuery = "",
  showLineNumbers = false,
  startingLineNumber = 1,
  wordWrap = false,
}: {
  activeSearchMatchIndex?: number;
  code: string;
  deferUntilHighlighted?: boolean;
  language: BundledLanguage;
  searchQuery?: string;
  showLineNumbers?: boolean;
  startingLineNumber?: number;
  wordWrap?: boolean;
}) => {
  const searchMatches = useMemo(
    () => findCodeSearchMatches(code, searchQuery),
    [code, searchQuery],
  );
  const highlighted = useHighlightedTokens(code, language);
  // File previews can avoid flashing unhighlighted text.
  const rawTokens = useMemo(
    () => (highlighted || deferUntilHighlighted ? null : createRawTokens(code)),
    [code, deferUntilHighlighted, highlighted],
  );
  const tokenized = highlighted ?? rawTokens;

  return (
    <div className={cn("relative", wordWrap ? "overflow-x-hidden" : "overflow-auto")}>
      {tokenized ? (
        <CodeBlockBody
          activeSearchMatchIndex={activeSearchMatchIndex}
          searchMatches={searchMatches}
          showLineNumbers={showLineNumbers}
          startingLineNumber={startingLineNumber}
          tokenized={tokenized}
          wordWrap={wordWrap}
        />
      ) : null}
    </div>
  );
};

export const CodeBlock = ({
  activeSearchMatchIndex = -1,
  code,
  deferUntilHighlighted = false,
  language,
  searchQuery = "",
  showLineNumbers = false,
  startingLineNumber = 1,
  wordWrap = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code]);

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent
          activeSearchMatchIndex={activeSearchMatchIndex}
          code={code}
          deferUntilHighlighted={deferUntilHighlighted}
          language={language}
          searchQuery={searchQuery}
          showLineNumbers={showLineNumbers}
          startingLineNumber={startingLineNumber}
          wordWrap={wordWrap}
        />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  text?: string;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  text,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);
  const copyValue = text ?? code;

  const copyToClipboard = useCallback(async () => {
    try {
      if (!isCopied) {
        await copyTextToClipboard(copyValue);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout,
        );
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [copyValue, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={copyToClipboard}
      size="icon-xs"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon className="size-3.5" />}
    </Button>
  );
};

export type CodeBlockDownloadButtonProps = ComponentProps<typeof Button> & {
  filename?: string;
  language?: string;
  onDownload?: () => void;
  onError?: (error: Error) => void;
};

export const CodeBlockDownloadButton = ({
  filename,
  language = "text",
  onDownload,
  onError,
  children,
  className,
  ...props
}: CodeBlockDownloadButtonProps) => {
  const aiT = useTranslations("aiElements");
  const { code } = useContext(CodeBlockContext);

  const handleDownload = useCallback(async () => {
    try {
      await downloadTextFile(
        filename || getCodeBlockDownloadFilename(language),
        code,
        aiT("saveCodeBlock"),
      );
      onDownload?.();
    } catch (error) {
      onError?.(error as Error);
    }
  }, [aiT, code, filename, language, onDownload, onError]);

  return (
    <Button
      className={cn("shrink-0", className)}
      onClick={handleDownload}
      size="icon-xs"
      variant="ghost"
      {...props}
    >
      {children ?? <DownloadIcon className="size-3.5" />}
    </Button>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (
  props: CodeBlockLanguageSelectorProps,
) => <Select {...props} />;

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
    <SelectTrigger
      className={cn(
        "h-7 border-none bg-transparent px-2 text-sm shadow-none",
        className,
      )}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<
  typeof SelectValue
>;

export const CodeBlockLanguageSelectorValue = (
  props: CodeBlockLanguageSelectorValueProps,
) => <SelectValue {...props} />;

export type CodeBlockLanguageSelectorContentProps = ComponentProps<
  typeof SelectContent
>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => (
  <SelectContent align={align} {...props} />
);

export type CodeBlockLanguageSelectorItemProps = ComponentProps<
  typeof SelectItem
>;

export const CodeBlockLanguageSelectorItem = (
  props: CodeBlockLanguageSelectorItemProps,
) => <SelectItem {...props} />;
