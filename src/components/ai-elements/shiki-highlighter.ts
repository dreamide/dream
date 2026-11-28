import {
  type CodeToTokensOptions,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
  type TokensResult,
} from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import type { CODE_THEMES } from "@/components/ai-elements/incremental-tokens";

type LanguageLoader = () => Promise<{
  default: LanguageRegistration | LanguageRegistration[];
}>;

// Curated language grammars loaded on demand via shiki/core so Vite does not
// emit hundreds of unused grammar chunks from the full shiki bundle.
const SHIKI_LANGUAGE_LOADERS: Record<string, LanguageLoader> = {
  astro: () => import("shiki/langs/astro.mjs"),
  awk: () => import("shiki/langs/awk.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  bat: () => import("shiki/langs/bat.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cmake: () => import("shiki/langs/cmake.mjs"),
  coffee: () => import("shiki/langs/coffee.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  csv: () => import("shiki/langs/csv.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  erlang: () => import("shiki/langs/erlang.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  glsl: () => import("shiki/langs/glsl.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  haml: () => import("shiki/langs/haml.mjs"),
  handlebars: () => import("shiki/langs/handlebars.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  http: () => import("shiki/langs/http.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jinja: () => import("shiki/langs/jinja.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  jsonl: () => import("shiki/langs/jsonl.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  julia: () => import("shiki/langs/julia.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  log: () => import("shiki/langs/log.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  make: () => import("shiki/langs/make.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  matlab: () => import("shiki/langs/matlab.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  mermaid: () => import("shiki/langs/mermaid.mjs"),
  nginx: () => import("shiki/langs/nginx.mjs"),
  nix: () => import("shiki/langs/nix.mjs"),
  "objective-c": () => import("shiki/langs/objective-c.mjs"),
  ocaml: () => import("shiki/langs/ocaml.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  postcss: () => import("shiki/langs/postcss.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  prisma: () => import("shiki/langs/prisma.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  pug: () => import("shiki/langs/pug.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  regex: () => import("shiki/langs/regex.mjs"),
  rst: () => import("shiki/langs/rst.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  scheme: () => import("shiki/langs/scheme.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  shellsession: () => import("shiki/langs/shellsession.mjs"),
  solidity: () => import("shiki/langs/solidity.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  stylus: () => import("shiki/langs/stylus.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  tex: () => import("shiki/langs/tex.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  twig: () => import("shiki/langs/twig.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  vb: () => import("shiki/langs/vb.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  wasm: () => import("shiki/langs/wasm.mjs"),
  wgsl: () => import("shiki/langs/wgsl.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  zig: () => import("shiki/langs/zig.mjs"),
};

const SHIKI_LANGUAGE_ALIASES: Record<string, string> = {
  batch: "bat",
  "c#": "csharp",
  "c++": "cpp",
  cmd: "bat",
  coffeescript: "coffee",
  console: "shellsession",
  cs: "csharp",
  docker: "dockerfile",
  env: "dotenv",
  gql: "graphql",
  hbs: "handlebars",
  hs: "haskell",
  js: "javascript",
  kt: "kotlin",
  makefile: "make",
  md: "markdown",
  objc: "objective-c",
  pl: "perl",
  protobuf: "proto",
  ps: "powershell",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  "shell-session": "shellsession",
  sol: "solidity",
  tf: "terraform",
  ts: "typescript",
  wat: "wasm",
  yml: "yaml",
  zsh: "bash",
};

const SPECIAL_SHIKI_LANGUAGES = new Set([
  "ansi",
  "output",
  "plain",
  "plaintext",
  "text",
  "txt",
]);

const resolveCanonicalLanguage = (language: string): string => {
  const normalized = language.trim().toLowerCase();
  if (!normalized || SPECIAL_SHIKI_LANGUAGES.has(normalized)) {
    return normalized === "ansi" ? "ansi" : "text";
  }
  const canonical = SHIKI_LANGUAGE_ALIASES[normalized] ?? normalized;
  return SHIKI_LANGUAGE_LOADERS[canonical] ? canonical : "text";
};

type CodeThemeName = (typeof CODE_THEMES)[keyof typeof CODE_THEMES];

export interface CodeHighlighterAdapter {
  codeToTokens: (
    code: string,
    options: CodeToTokensOptions<string, CodeThemeName>,
  ) => TokensResult;
}

let coreHighlighterPromise: Promise<HighlighterCore> | null = null;
const loadedCanonicalLanguages = new Set<string>(["text", "ansi"]);
const loadingLanguages = new Map<string, Promise<void>>();

const getCoreHighlighter = () => {
  if (!coreHighlighterPromise) {
    coreHighlighterPromise = Promise.all([
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
      createOnigurumaEngine(() => import("shiki/wasm")),
    ]).then(([githubLight, githubDark, engine]) =>
      createHighlighterCore({
        engine,
        langs: [],
        themes: [githubLight.default, githubDark.default],
      }),
    );
  }
  return coreHighlighterPromise;
};

const ensureLanguageLoaded = async (
  highlighter: HighlighterCore,
  canonical: string,
) => {
  if (loadedCanonicalLanguages.has(canonical)) {
    return;
  }

  let pending = loadingLanguages.get(canonical);
  if (!pending) {
    const loader = SHIKI_LANGUAGE_LOADERS[canonical];
    if (!loader) {
      return;
    }
    pending = loader()
      .then((module) => highlighter.loadLanguage(module.default))
      .then(() => {
        loadedCanonicalLanguages.add(canonical);
      })
      .finally(() => {
        loadingLanguages.delete(canonical);
      });
    loadingLanguages.set(canonical, pending);
  }
  await pending;
};

const wrapCoreHighlighter = (
  highlighter: HighlighterCore,
): CodeHighlighterAdapter => ({
  codeToTokens: (code, options) => {
    const requested = typeof options.lang === "string" ? options.lang : "text";
    const canonical = resolveCanonicalLanguage(requested);
    const lang = loadedCanonicalLanguages.has(canonical) ? canonical : "text";
    return highlighter.codeToTokens(code, {
      ...options,
      lang,
    });
  },
});

let cachedAdapter: CodeHighlighterAdapter | null = null;

export const getCodeHighlighter = async (
  language: string,
): Promise<CodeHighlighterAdapter> => {
  const highlighter = await getCoreHighlighter();
  const canonical = resolveCanonicalLanguage(language);
  await ensureLanguageLoaded(highlighter, canonical);
  if (!cachedAdapter) {
    cachedAdapter = wrapCoreHighlighter(highlighter);
  }
  return cachedAdapter;
};
