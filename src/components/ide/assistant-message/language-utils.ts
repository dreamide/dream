import type { BundledLanguage } from "shiki";

export const extToLanguage: Record<string, BundledLanguage> = {
  astro: "astro",
  bash: "bash",
  c: "c",
  coffee: "coffee",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  elm: "elm",
  env: "dotenv",
  erl: "erlang",
  ex: "elixir",
  go: "go",
  graphql: "graphql",
  h: "c",
  hbs: "handlebars",
  hpp: "cpp",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json5",
  jsonc: "jsonc",
  jsx: "jsx",
  kt: "kotlin",
  less: "less",
  lua: "lua",
  md: "markdown",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  php: "php",
  prisma: "prisma",
  proto: "proto",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scala: "scala",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  svelte: "svelte",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  txt: "log",
  vue: "vue",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
  zsh: "bash",
};

export const inferLanguage = (filePath: string): BundledLanguage => {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return extToLanguage[ext] ?? "log";
};

export const normalizeEmbeddedLineNumbers = (
  content: string,
  startLine?: number | null,
): {
  code: string;
  hadEmbeddedLineNumbers: boolean;
  startingLineNumber: number;
} => {
  const sanitizedContent = content
    .replace(/\r\n/g, "\n")
    .replace(/\n*<system-reminder>[\s\S]*?<\/system-reminder>\s*$/i, "");
  const lines = sanitizedContent.split("\n");
  if (lines.length < 2) {
    return {
      code: sanitizedContent,
      hadEmbeddedLineNumbers: false,
      startingLineNumber: startLine ?? 1,
    };
  }

  type ParsedLine = {
    code: string;
    kind: "bare" | "explicit" | "spaces" | "tab";
    lineNumber: number;
    spacePrefix?: string;
  };

  const parseLine = (line: string): ParsedLine | null => {
    const explicitMatch = line.match(/^\s*(\d+)\s*(?:\||:|->|→|↦|›)\s?(.*)$/);
    const tabMatch = line.match(/^\s*(\d+)\t+(.*)$/);
    const spacesMatch = line.match(/^\s*(\d+)( {2,})(.*)$/);
    const bareMatch = line.match(/^\s*(\d+)\s*$/);
    const match = explicitMatch ?? tabMatch ?? spacesMatch ?? bareMatch;

    if (!match) {
      return null;
    }

    const lineNumber = Number(match[1]);
    if (!Number.isFinite(lineNumber)) {
      return null;
    }

    if (explicitMatch) {
      return {
        code: explicitMatch[2] ?? "",
        kind: "explicit",
        lineNumber,
      };
    }

    if (tabMatch) {
      return {
        code: tabMatch[2] ?? "",
        kind: "tab",
        lineNumber,
      };
    }

    if (spacesMatch) {
      return {
        code: spacesMatch[3] ?? "",
        kind: "spaces",
        lineNumber,
        spacePrefix: spacesMatch[2] ?? "",
      };
    }

    return {
      code: "",
      kind: "bare",
      lineNumber,
    };
  };

  const parsedLines = lines.map(parseLine);

  let bestRun: {
    lines: ParsedLine[];
    startingLineNumber: number;
    startsAtRequestedLine: boolean;
  } | null = null;

  const getNormalizedRunLines = (runLines: ParsedLine[]): string[] => {
    const spacePrefixWidth = Math.min(
      ...runLines
        .filter((line) => line.kind === "spaces" && line.code.trim().length > 0)
        .map((line) => line.spacePrefix?.length ?? 0),
    );

    return runLines.map((line) => {
      if (line.kind !== "spaces" || !Number.isFinite(spacePrefixWidth)) {
        return line.code;
      }

      return `${line.spacePrefix?.slice(spacePrefixWidth) ?? ""}${line.code}`;
    });
  };

  for (let index = 0; index < parsedLines.length; index += 1) {
    const parsedLine = parsedLines[index];
    if (!parsedLine) {
      continue;
    }

    const runLines = [parsedLine];
    const runStart = parsedLine.lineNumber;
    let expected = parsedLine.lineNumber + 1;

    for (
      let nextIndex = index + 1;
      nextIndex < parsedLines.length;
      nextIndex += 1
    ) {
      const nextLine = parsedLines[nextIndex];
      if (!nextLine || nextLine.lineNumber !== expected) {
        break;
      }

      runLines.push(nextLine);
      expected += 1;
    }

    if (runLines.length < 2) {
      continue;
    }

    const hasLineNumberSeparator = runLines.some(
      (line) => line.kind !== "bare",
    );
    const hasCode = runLines.some((line) => line.code.trim().length > 0);
    if (!hasLineNumberSeparator || !hasCode) {
      continue;
    }

    const startsAtRequestedLine =
      startLine !== null && startLine !== undefined && runStart === startLine;

    if (
      !bestRun ||
      (startsAtRequestedLine && !bestRun.startsAtRequestedLine) ||
      (startsAtRequestedLine === bestRun.startsAtRequestedLine &&
        runLines.length > bestRun.lines.length)
    ) {
      bestRun = {
        lines: runLines,
        startingLineNumber: runStart,
        startsAtRequestedLine,
      };
    }
  }

  if (!bestRun) {
    return {
      code: sanitizedContent,
      hadEmbeddedLineNumbers: false,
      startingLineNumber: startLine ?? 1,
    };
  }

  return {
    code: getNormalizedRunLines(bestRun.lines).join("\n"),
    hadEmbeddedLineNumbers: true,
    startingLineNumber: bestRun.startingLineNumber,
  };
};
