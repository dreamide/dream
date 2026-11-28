import type { FileTreeIcons, RemappedIcon } from "@pierre/trees";
import { FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

type IconImageProps = Omit<ComponentProps<"img">, "alt">;
type MaterialIconProps = Omit<IconImageProps, "src">;

// Keep the startup icon surface intentionally small. Uncommon file types use
// the Lucide fallback instead of forcing Vite to eagerly register every SVG or
// ship the full ~450 KB material-icon-theme manifest JSON.
const materialIconUrls = import.meta.glob(
  [
    "/node_modules/material-icon-theme/icons/c.svg",
    "/node_modules/material-icon-theme/icons/cpp.svg",
    "/node_modules/material-icon-theme/icons/css.svg",
    "/node_modules/material-icon-theme/icons/database.svg",
    "/node_modules/material-icon-theme/icons/docker.svg",
    "/node_modules/material-icon-theme/icons/file.svg",
    "/node_modules/material-icon-theme/icons/folder-config-open.svg",
    "/node_modules/material-icon-theme/icons/folder-config.svg",
    "/node_modules/material-icon-theme/icons/folder-git-open.svg",
    "/node_modules/material-icon-theme/icons/folder-git.svg",
    "/node_modules/material-icon-theme/icons/folder-node-open.svg",
    "/node_modules/material-icon-theme/icons/folder-node.svg",
    "/node_modules/material-icon-theme/icons/folder-open.svg",
    "/node_modules/material-icon-theme/icons/folder-public-open.svg",
    "/node_modules/material-icon-theme/icons/folder-public.svg",
    "/node_modules/material-icon-theme/icons/folder-src-open.svg",
    "/node_modules/material-icon-theme/icons/folder-src.svg",
    "/node_modules/material-icon-theme/icons/folder-test-open.svg",
    "/node_modules/material-icon-theme/icons/folder-test.svg",
    "/node_modules/material-icon-theme/icons/folder.svg",
    "/node_modules/material-icon-theme/icons/git.svg",
    "/node_modules/material-icon-theme/icons/go.svg",
    "/node_modules/material-icon-theme/icons/html.svg",
    "/node_modules/material-icon-theme/icons/image.svg",
    "/node_modules/material-icon-theme/icons/java.svg",
    "/node_modules/material-icon-theme/icons/javascript.svg",
    "/node_modules/material-icon-theme/icons/json.svg",
    "/node_modules/material-icon-theme/icons/lock.svg",
    "/node_modules/material-icon-theme/icons/markdown.svg",
    "/node_modules/material-icon-theme/icons/nodejs.svg",
    "/node_modules/material-icon-theme/icons/npm.svg",
    "/node_modules/material-icon-theme/icons/python.svg",
    "/node_modules/material-icon-theme/icons/react.svg",
    "/node_modules/material-icon-theme/icons/readme.svg",
    "/node_modules/material-icon-theme/icons/rust.svg",
    "/node_modules/material-icon-theme/icons/sass.svg",
    "/node_modules/material-icon-theme/icons/svg.svg",
    "/node_modules/material-icon-theme/icons/typescript.svg",
    "/node_modules/material-icon-theme/icons/vite.svg",
    "/node_modules/material-icon-theme/icons/xml.svg",
    "/node_modules/material-icon-theme/icons/yaml.svg",
  ],
  {
    eager: true,
    import: "default",
    query: "?url",
  },
) as Record<string, string>;

const DEFAULT_FILE_ICON = "file";
const DEFAULT_FOLDER_ICON = "folder";
const DEFAULT_FOLDER_EXPANDED_ICON = "folder-open";

const expandIconGroups = (
  groups: Record<string, readonly string[]>,
): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const [iconName, keys] of Object.entries(groups)) {
    for (const key of keys) {
      map[key] = iconName;
    }
  }
  return map;
};

const FILE_EXTENSIONS = expandIconGroups({
  c: ["c", "i", "mi"],
  cpp: [
    "cc",
    "cpp",
    "cxx",
    "c++",
    "cp",
    "mii",
    "ii",
    "cppm",
    "c++m",
    "ccm",
    "cxxm",
    "h.in",
    "hpp.in",
    "ipp",
    "ixx",
    "tpp",
    "txx",
  ],
  css: ["css"],
  database: [
    "pdb",
    "sql",
    "pks",
    "pkb",
    "accdb",
    "mdb",
    "sqlite",
    "sqlite3",
    "pgsql",
    "postgres",
    "plpgsql",
    "psql",
    "db",
    "db3",
    "dblite",
    "dblite3",
    "debugsymbols",
    "odb",
    "accde",
    "adp",
    "bak",
    "bdb",
    "dbf",
    "fdb",
    "feather",
    "gdb",
    "ibd",
    "mdf",
    "mde",
    "myd",
    "myi",
    "ndf",
    "orc",
    "parquet",
    "sdf",
    "ldf",
    "frm",
    "kdbx",
    "dsql",
  ],
  docker: [
    "dockerignore",
    "dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    "containerignore",
    "containerfile",
    "compose.yaml",
    "compose.yml",
  ],
  git: ["patch"],
  go: ["go"],
  html: [
    "htm",
    "xhtml",
    "html_vm",
    "asp",
    "html",
    "aspx",
    "jshtm",
    "rhtml",
    "shtml",
    "volt",
    "xht",
  ],
  image: [
    "png",
    "jpeg",
    "jpg",
    "gif",
    "ico",
    "tif",
    "tiff",
    "ami",
    "apx",
    "avif",
    "bmp",
    "bpg",
    "brk",
    "cur",
    "dds",
    "exr",
    "fpx",
    "gbr",
    "img",
    "jbig2",
    "jb2",
    "jng",
    "jxl",
    "jxr",
    "pgf",
    "pic",
    "raw",
    "webp",
    "eps",
    "afphoto",
    "ase",
    "aseprite",
    "clip",
    "cpt",
    "heif",
    "heic",
    "kra",
    "mdp",
    "ora",
    "pdn",
    "reb",
    "sai",
    "tga",
    "xcf",
    "jfif",
    "ppm",
    "pbm",
    "pgm",
    "pnm",
    "icns",
    "3fr",
    "ari",
    "arw",
    "bay",
    "braw",
    "crw",
    "cr2",
    "cr3",
    "cap",
    "data",
    "dcs",
    "dcr",
    "dng",
    "drf",
    "eip",
    "erf",
    "fff",
    "gpr",
    "iiq",
    "k25",
    "kdc",
    "mdc",
    "mef",
    "mos",
    "mrw",
    "nef",
    "nrw",
    "obm",
    "orf",
    "pef",
    "ptx",
    "pxn",
    "r3d",
    "raf",
    "rwl",
    "rw2",
    "rwz",
    "sr2",
    "srf",
    "srw",
    "x3f",
    "ktx",
    "ktx2",
  ],
  java: ["java", "jsp", "jav"],
  javascript: ["esx", "mjs", "js", "cjs", "es6", "pac"],
  json: [
    "json",
    "jsonc",
    "tsbuildinfo",
    "json5",
    "jsonl",
    "ndjson",
    "geojson",
    "har",
    "jsonld",
    "webmanifest",
    "ts.map",
  ],
  lock: ["lock"],
  markdown: [
    "md",
    "markdown",
    "rst",
    "copilotmd",
    "litcoffee",
    "markdn",
    "mdown",
    "mdtext",
    "mdtxt",
    "mdwn",
    "mkd",
    "mkdn",
    "ronn",
    "workbook",
  ],
  python: ["py", "cpy", "gyp", "gypi", "ipy", "pyi", "pyt", "pyw", "rpy"],
  react: ["jsx"],
  rust: ["rs", "ron"],
  sass: ["scss", "sass"],
  svg: ["svg"],
  typescript: ["ts", "cts", "mts"],
  xml: [
    "xml",
    "plist",
    "xsd",
    "dtd",
    "xsl",
    "xslt",
    "resx",
    "iml",
    "xquery",
    "tmLanguage",
    "manifest",
    "project",
    "xml.dist",
    "xml.dist.sample",
    "dmn",
    "jrxml",
    "xmp",
    "ascx",
    "atom",
    "axaml",
    "axml",
    "bpmn",
    "csl",
    "csproj.user",
    "dita",
    "ditamap",
    "dtml",
    "ent",
    "fxml",
    "isml",
    "jmx",
    "launch",
    "menu",
    "opml",
    "owl",
    "proj",
    "publishsettings",
    "pubxml",
    "pubxml.user",
    "rdf",
    "rng",
    "rss",
    "shproj",
    "storyboard",
    "targets",
    "tld",
    "tmx",
    "vbproj",
    "vbproj.user",
    "wsdl",
    "wxi",
    "wxl",
    "wxs",
    "xbl",
    "xib",
    "xliff",
    "xoml",
    "xpdl",
    "xul",
  ],
  yaml: [
    "yml.dist",
    "yaml.dist",
    "YAML-tmLanguage",
    "yaml",
    "yml",
    "cff",
    "eyaml",
    "eyml",
    "winget",
    "yaml-tmpreferences",
    "yaml-tmtheme",
  ],
});

const DOCKER_ENVIRONMENTS = [
  "",
  ".prod",
  ".production",
  ".alpha",
  ".beta",
  ".stage",
  ".staging",
  ".dev",
  ".development",
  ".local",
  ".test",
  ".testing",
  ".ci",
  ".web",
  ".windows",
  ".worker",
];
const COMPOSE_ENVIRONMENTS = [
  "",
  ".override",
  ".prod",
  ".production",
  ".alpha",
  ".beta",
  ".stage",
  ".staging",
  ".dev",
  ".development",
  ".local",
  ".test",
  ".testing",
  ".ci",
  ".web",
  ".worker",
];

const FILE_NAMES = expandIconGroups({
  docker: [
    ...DOCKER_ENVIRONMENTS.map((suffix) => `dockerfile${suffix}`),
    ...DOCKER_ENVIRONMENTS.map((suffix) => `containerfile${suffix}`),
    ...COMPOSE_ENVIRONMENTS.map((suffix) => `docker-compose${suffix}.yml`),
    ...COMPOSE_ENVIRONMENTS.map((suffix) => `docker-compose${suffix}.yaml`),
    ...COMPOSE_ENVIRONMENTS.map((suffix) => `compose${suffix}.yaml`),
    ...COMPOSE_ENVIRONMENTS.map((suffix) => `compose${suffix}.yml`),
  ],
  git: [
    ".git",
    ".gitignore",
    ".gitmessage",
    ".gitignore-global",
    ".gitignore_global",
    ".gitattributes",
    ".gitattributes-global",
    ".gitattributes_global",
    ".gitconfig",
    ".gitmodules",
    ".gitkeep",
    ".keep",
    ".gitpreserve",
    ".gitinclude",
    ".git-blame-ignore",
    ".git-blame-ignore-revs",
    ".git-for-windows-updater",
    "git-history",
    "COMMIT_EDITMSG",
    "MERGE_MSG",
    "git-rebase-todo",
  ],
  javascript: ["jakefile"],
  json: [
    ".jscsrc",
    ".jshintrc",
    "composer.lock",
    ".jsbeautifyrc",
    ".esformatter",
    "cdp.pid",
    ".whitesource",
  ],
  lock: ["security.md", "security.txt", "security"],
  nodejs: [
    "package.json",
    "package-lock.json",
    ".nvmrc",
    ".esmrc",
    ".node-version",
  ],
  npm: [".npmignore", ".npmrc"],
  readme: ["readme.md", "readme.rst", "readme.txt", "readme"],
  vite: [
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.cjs",
    "vite.config.ts",
    "vite.config.mts",
    "vite.config.cts",
  ],
  xml: [".htaccess"],
});

const expandFolderVariants = (roots: readonly string[]) =>
  roots.flatMap((root) => [
    root,
    `.${root}`,
    `_${root}`,
    `-${root}`,
    `__${root}__`,
  ]);

const FOLDER_NAMES = expandIconGroups({
  "folder-config": expandFolderVariants([
    "cfg",
    "cfgs",
    "conf",
    "confs",
    "config",
    "configs",
    "configuration",
    "configurations",
    "setting",
    "settings",
    "META-INF",
    "option",
    "options",
    "pref",
    "prefs",
    "preference",
    "preferences",
    "props",
    "properties",
  ]),
  "folder-git": expandFolderVariants([
    "git",
    "patches",
    "githooks",
    "submodules",
  ]),
  "folder-node": expandFolderVariants(["node", "nodejs", "node_modules"]),
  "folder-public": expandFolderVariants([
    "public",
    "www",
    "wwwroot",
    "web",
    "website",
    "websites",
    "site",
    "browser",
    "browsers",
    "proxy",
  ]),
  "folder-src": expandFolderVariants([
    "src",
    "srcs",
    "source",
    "sources",
    "code",
  ]),
  "folder-test": expandFolderVariants([
    "test",
    "tests",
    "testing",
    "snapshots",
    "spec",
    "specs",
    "testfiles",
  ]),
});

const LANGUAGE_IDS = expandIconGroups({
  c: ["c"],
  cpp: ["cpp"],
  css: ["css"],
  database: ["sql"],
  docker: ["dockerfile", "dockercompose", "dockerbake"],
  git: ["git", "git-commit", "git-rebase", "ignore"],
  go: ["go"],
  html: ["html"],
  java: ["java"],
  javascript: ["javascript"],
  json: ["json", "jsonl", "jsonc", "json5"],
  lock: ["ssh_config"],
  markdown: ["markdown"],
  python: ["python"],
  react: ["javascriptreact"],
  rust: ["rust"],
  sass: ["sass", "scss"],
  svg: ["svg"],
  typescript: ["typescript", "ets"],
  xml: ["xml", "xquery", "xsl"],
  yaml: ["yaml", "spring-boot-properties-yaml", "ansible", "ansible-jinja"],
});

const LANGUAGE_BY_EXTENSION: Partial<Record<string, string>> = {
  cjs: "javascript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  mts: "typescript",
  ts: "typescript",
  tsx: "typescriptreact",
};

const normalizePath = (path: string) => path.replace(/\\/g, "/").toLowerCase();

const normalizeIconRuleKey = (value: string) =>
  normalizePath(value.trim()).replace(/^\./, "");

const getBasename = (path: string) => {
  const normalizedPath = normalizePath(path);
  return normalizedPath.split("/").pop() ?? normalizedPath;
};

const getExtensionCandidates = (path: string) => {
  const basename = getBasename(path);
  const parts = basename.split(".").filter(Boolean);
  const candidates: string[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    candidates.push(parts.slice(index).join("."));
  }

  return candidates.sort((left, right) => right.length - left.length);
};

const lookupFirst = (
  table: Record<string, string>,
  candidates: readonly string[],
) => {
  for (const candidate of candidates) {
    const value = table[candidate];
    if (value) {
      return value;
    }
  }
  return null;
};

const resolveIconUrl = (iconName: string | null | undefined) => {
  if (!iconName) {
    return null;
  }

  return materialIconUrls[
    `/node_modules/material-icon-theme/icons/${iconName}.svg`
  ];
};

const toMaterialSymbolId = (iconName: string) =>
  `material-icon-${iconName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

const getSvgViewBox = () => "0 0 16 16";

const toMaterialIconReference = (
  iconName: string | null | undefined,
): RemappedIcon | null => {
  if (!iconName || !resolveIconUrl(iconName)) {
    return null;
  }

  return {
    name: toMaterialSymbolId(iconName),
    viewBox: getSvgViewBox(),
  };
};

const escapeSvgAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const createMaterialIconSymbol = (iconName: string) => {
  const iconUrl = resolveIconUrl(iconName);
  if (!iconUrl) {
    return null;
  }

  const symbolId = toMaterialSymbolId(iconName);
  const imageUrl = escapeSvgAttribute(iconUrl);

  return `<symbol id="${symbolId}" viewBox="${getSvgViewBox()}"><image href="${imageUrl}" width="16" height="16" preserveAspectRatio="xMidYMid meet" /></symbol>`;
};

const createMaterialSpriteSheet = () => {
  const iconNames = new Set<string>([
    DEFAULT_FILE_ICON,
    DEFAULT_FOLDER_ICON,
    DEFAULT_FOLDER_EXPANDED_ICON,
    ...Object.values(FILE_EXTENSIONS),
    ...Object.values(FILE_NAMES),
    ...Object.values(LANGUAGE_IDS),
  ]);

  const symbols = Array.from(iconNames)
    .map(createMaterialIconSymbol)
    .filter((symbol): symbol is string => Boolean(symbol));

  return `<svg data-icon-sprite aria-hidden="true" width="0" height="0" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${symbols.join("")}</svg>`;
};

const createMaterialFileNameIconRules = () => {
  const rules: Record<string, RemappedIcon> = {};

  for (const [fileName, iconName] of Object.entries(FILE_NAMES)) {
    const icon = toMaterialIconReference(iconName);
    if (!icon) {
      continue;
    }

    rules[normalizePath(fileName)] = icon;
    rules[getBasename(fileName)] = icon;
  }

  return rules;
};

const createMaterialFileExtensionIconRules = () => {
  const rules: Record<string, RemappedIcon> = {};

  for (const [extension, iconName] of Object.entries(FILE_EXTENSIONS)) {
    const icon = toMaterialIconReference(iconName);
    if (icon) {
      rules[normalizeIconRuleKey(extension)] = icon;
    }
  }

  for (const [extension, languageId] of Object.entries(LANGUAGE_BY_EXTENSION)) {
    if (!languageId) {
      continue;
    }

    const icon = toMaterialIconReference(LANGUAGE_IDS[languageId]);
    if (icon && !rules[extension]) {
      rules[extension] = icon;
    }
  }

  return rules;
};

const resolveFileIconName = (path: string) => {
  const normalizedPath = normalizePath(path);
  const basename = getBasename(path);
  const nameCandidates = [normalizedPath, basename];
  const extensionCandidates = getExtensionCandidates(path);
  const languageCandidates = extensionCandidates.flatMap((candidate) => {
    const languageId = LANGUAGE_BY_EXTENSION[candidate];
    return languageId ? [languageId] : [];
  });

  return (
    lookupFirst(FILE_NAMES, nameCandidates) ??
    lookupFirst(FILE_EXTENSIONS, extensionCandidates) ??
    lookupFirst(LANGUAGE_IDS, languageCandidates) ??
    DEFAULT_FILE_ICON
  );
};

const resolveFolderIconName = (name: string, expanded: boolean) => {
  const iconName = FOLDER_NAMES[normalizePath(name)];
  if (iconName) {
    return expanded ? `${iconName}-open` : iconName;
  }
  return expanded ? DEFAULT_FOLDER_EXPANDED_ICON : DEFAULT_FOLDER_ICON;
};

const MaterialIconImage = ({ className, ...props }: IconImageProps) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 object-contain", className)}
    draggable={false}
    {...props}
  />
);

export const MaterialFileIcon = ({
  className,
  path,
}: MaterialIconProps & { path: string }) => {
  const iconName = resolveFileIconName(path);
  const iconUrl = resolveIconUrl(iconName);

  if (!iconUrl) {
    return (
      <FileIcon className={cn("size-4 text-muted-foreground", className)} />
    );
  }

  return <MaterialIconImage className={className} src={iconUrl} />;
};

export const MaterialFolderIcon = ({
  className,
  expanded = false,
  name,
}: MaterialIconProps & { expanded?: boolean; name: string }) => {
  const iconName = resolveFolderIconName(name, expanded);
  const iconUrl = resolveIconUrl(iconName);

  if (!iconUrl) {
    const FolderFallbackIcon = expanded ? FolderOpenIcon : FolderIcon;
    return (
      <FolderFallbackIcon className={cn("size-4 text-blue-500", className)} />
    );
  }

  return <MaterialIconImage className={className} src={iconUrl} />;
};

let cachedFileTreeIcons: FileTreeIcons | null = null;

const getMaterialFileTreeIcons = (): FileTreeIcons => {
  if (cachedFileTreeIcons) {
    return cachedFileTreeIcons;
  }

  const defaultFileIcon = toMaterialIconReference(DEFAULT_FILE_ICON);
  cachedFileTreeIcons = {
    byFileExtension: createMaterialFileExtensionIconRules(),
    byFileName: createMaterialFileNameIconRules(),
    colored: false,
    remap: defaultFileIcon
      ? {
          "file-tree-icon-file": defaultFileIcon,
        }
      : undefined,
    set: "none",
    spriteSheet: createMaterialSpriteSheet(),
  };
  return cachedFileTreeIcons;
};

export const useMaterialFileTreeIcons = (): FileTreeIcons =>
  getMaterialFileTreeIcons();
