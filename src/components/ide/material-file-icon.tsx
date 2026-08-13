import type { FileTreeIcons, RemappedIcon } from "@pierre/trees";
import { FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { Manifest } from "material-icon-theme";
import materialIconManifest from "material-icon-theme/dist/material-icons.json";
import { useTheme } from "next-themes";
import { type ComponentProps, useMemo } from "react";
import { cn } from "@/lib/utils";

type IconImageProps = Omit<ComponentProps<"img">, "alt">;
type MaterialIconProps = Omit<IconImageProps, "src">;

const manifest = materialIconManifest as Manifest;
// Keep the startup icon surface intentionally small. Uncommon file types use
// the Lucide fallback instead of forcing Vite to eagerly register every SVG in
// material-icon-theme (hundreds of assets and URL entries).
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

const resolveManifestValue = (
  preferredManifest: Manifest | undefined,
  fallbackManifest: Manifest,
  key: keyof Pick<
    Manifest,
    | "fileExtensions"
    | "fileNames"
    | "folderNames"
    | "folderNamesExpanded"
    | "languageIds"
  >,
  candidates: string[],
) => {
  for (const candidate of candidates) {
    const preferredValue = preferredManifest?.[key]?.[candidate];
    if (preferredValue) {
      return preferredValue;
    }

    const fallbackValue = fallbackManifest[key]?.[candidate];
    if (fallbackValue) {
      return fallbackValue;
    }
  }

  return null;
};

const resolveIconUrl = (iconName: string | null | undefined) => {
  if (!iconName) {
    return null;
  }

  const iconPath = manifest.iconDefinitions?.[iconName]?.iconPath;
  const filename = iconPath?.split("/").pop();
  if (!filename) {
    return null;
  }

  return materialIconUrls[
    `/node_modules/material-icon-theme/icons/${filename}`
  ];
};

const toMaterialSymbolId = (iconName: string) =>
  `material-icon-${iconName.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

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

const getSvgViewBox = () => "0 0 16 16";

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

const addManifestIconNames = (
  iconNames: Set<string>,
  sourceManifest: Manifest | undefined,
) => {
  if (!sourceManifest) {
    return;
  }

  for (const iconName of [
    sourceManifest.file,
    sourceManifest.folder,
    sourceManifest.folderExpanded,
  ]) {
    if (iconName) {
      iconNames.add(iconName);
    }
  }

  for (const values of [
    sourceManifest.fileExtensions,
    sourceManifest.fileNames,
    sourceManifest.languageIds,
  ]) {
    for (const iconName of Object.values(values ?? {})) {
      iconNames.add(iconName);
    }
  }
};

const createMaterialSpriteSheet = (preferredManifest: Manifest | undefined) => {
  const iconNames = new Set<string>();
  addManifestIconNames(iconNames, manifest);
  addManifestIconNames(iconNames, preferredManifest);

  const symbols = Array.from(iconNames)
    .map(createMaterialIconSymbol)
    .filter((symbol): symbol is string => Boolean(symbol));

  return `<svg data-icon-sprite aria-hidden="true" width="0" height="0" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">${symbols.join("")}</svg>`;
};

const createMaterialFileNameIconRules = (
  preferredManifest: Manifest | undefined,
) => {
  const rules: Record<string, RemappedIcon> = {};

  for (const sourceManifest of [manifest, preferredManifest]) {
    for (const [fileName, iconName] of Object.entries(
      sourceManifest?.fileNames ?? {},
    )) {
      const icon = toMaterialIconReference(iconName);
      if (!icon) {
        continue;
      }

      rules[normalizePath(fileName)] = icon;
      rules[getBasename(fileName)] = icon;
    }
  }

  return rules;
};

const createMaterialFileExtensionIconRules = (
  preferredManifest: Manifest | undefined,
) => {
  const rules: Record<string, RemappedIcon> = {};

  for (const sourceManifest of [manifest, preferredManifest]) {
    for (const [extension, iconName] of Object.entries(
      sourceManifest?.fileExtensions ?? {},
    )) {
      const icon = toMaterialIconReference(iconName);
      if (icon) {
        rules[normalizeIconRuleKey(extension)] = icon;
      }
    }
  }

  for (const [extension, languageId] of Object.entries(LANGUAGE_BY_EXTENSION)) {
    if (!languageId) {
      continue;
    }

    const iconName =
      preferredManifest?.languageIds?.[languageId] ??
      manifest.languageIds?.[languageId];
    const icon = toMaterialIconReference(iconName);

    if (icon && !rules[extension]) {
      rules[extension] = icon;
    }
  }

  return rules;
};

const usePreferredManifest = () => {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "light" ? manifest.light : undefined;
};

const resolveFileIconName = (
  path: string,
  preferredManifest: Manifest | undefined,
) => {
  const normalizedPath = normalizePath(path);
  const basename = getBasename(path);
  const nameCandidates = [normalizedPath, basename];
  const extensionCandidates = getExtensionCandidates(path);
  const languageCandidates = extensionCandidates.flatMap((candidate) => {
    const languageId = LANGUAGE_BY_EXTENSION[candidate];
    return languageId ? [languageId] : [];
  });

  return (
    resolveManifestValue(
      preferredManifest,
      manifest,
      "fileNames",
      nameCandidates,
    ) ??
    resolveManifestValue(
      preferredManifest,
      manifest,
      "fileExtensions",
      extensionCandidates,
    ) ??
    resolveManifestValue(
      preferredManifest,
      manifest,
      "languageIds",
      languageCandidates,
    ) ??
    manifest.file
  );
};

const resolveFolderIconName = (
  name: string,
  expanded: boolean,
  preferredManifest: Manifest | undefined,
) => {
  const key = expanded ? "folderNamesExpanded" : "folderNames";
  const fallbackIcon = expanded ? manifest.folderExpanded : manifest.folder;

  return (
    resolveManifestValue(preferredManifest, manifest, key, [
      normalizePath(name),
    ]) ?? fallbackIcon
  );
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
  const preferredManifest = usePreferredManifest();
  const iconName = resolveFileIconName(path, preferredManifest);
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
  const preferredManifest = usePreferredManifest();
  const iconName = resolveFolderIconName(name, expanded, preferredManifest);
  const iconUrl = resolveIconUrl(iconName);

  if (!iconUrl) {
    const FolderFallbackIcon = expanded ? FolderOpenIcon : FolderIcon;
    return (
      <FolderFallbackIcon className={cn("size-4 text-blue-500", className)} />
    );
  }

  return <MaterialIconImage className={className} src={iconUrl} />;
};

export const useMaterialFileTreeIcons = (): FileTreeIcons => {
  const preferredManifest = usePreferredManifest();

  return useMemo(() => {
    const defaultFileIcon = toMaterialIconReference(
      preferredManifest?.file ?? manifest.file,
    );

    return {
      byFileExtension: createMaterialFileExtensionIconRules(preferredManifest),
      byFileName: createMaterialFileNameIconRules(preferredManifest),
      colored: false,
      remap: defaultFileIcon
        ? {
            "file-tree-icon-file": defaultFileIcon,
          }
        : undefined,
      set: "none",
      spriteSheet: createMaterialSpriteSheet(preferredManifest),
    };
  }, [preferredManifest]);
};
