const COMMON_CODE_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "docker",
  "dockerfile",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kotlin",
  "log",
  "markdown",
  "md",
  "php",
  "powershell",
  "python",
  "ruby",
  "rust",
  "scss",
  "shell",
  "sql",
  "svelte",
  "swift",
  "text",
  "toml",
  "ts",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
  "yml",
] as const;

export const streamdownCodeRendererLanguages = [
  "txt",
  "plaintext",
  "plain",
  "console",
  "shell-session",
  "output",
  ...COMMON_CODE_LANGUAGES,
];

export const codeFenceLanguageMarkers = new Set(
  streamdownCodeRendererLanguages,
);

const CODE_LANGUAGE_ALIASES: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  cs: "csharp",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shellscript: "bash",
  text: "log",
  txt: "log",
};

export const normalizeCodeLanguage = (language: string) => {
  const normalized = language.trim().toLowerCase();
  return (CODE_LANGUAGE_ALIASES[normalized] ?? normalized) || "log";
};
