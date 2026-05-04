import { FolderIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ToolLikePart } from "../../assistant-message-tools";
import {
  buildFileTree,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  FileTree,
  FileTreeNodeView,
  getExpandedChipClasses,
  isRecord,
  isString,
  JsonBlock,
} from "../shared";

export const ListFilesChip = ({
  defaultExpanded = false,
  part,
  projectPath,
}: {
  defaultExpanded?: boolean;
  part: ToolLikePart;
  projectPath?: string | null;
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  const { files, count } = useMemo(() => {
    if (!isRecord(output)) {
      return { files: null, count: 0 };
    }
    const candidates = [
      output.files,
      output.matches,
      output.paths,
      output.results,
    ].find(Array.isArray);

    if (!Array.isArray(candidates)) {
      return { files: null, count: 0 };
    }

    const filtered = candidates
      .map((item) => {
        if (isString(item)) {
          return item;
        }
        if (isRecord(item) && isString(item.path)) {
          return item.path;
        }
        if (isRecord(item) && isString(item.file)) {
          return item.file;
        }
        return null;
      })
      .filter((item): item is string => item !== null);

    return {
      files: filtered,
      count: typeof output.count === "number" ? output.count : filtered.length,
    };
  }, [output]);

  const { root, defaultExpandedFolders } = useMemo(() => {
    if (!files) {
      return { root: null, defaultExpandedFolders: new Set<string>() };
    }
    const tree = buildFileTree(files);
    return { root: tree.root, defaultExpandedFolders: tree.defaultExpanded };
  }, [files]);

  const hasOutput = files !== null && root !== null;
  const hasRawOutput = output !== undefined;
  const canExpand = hasError || hasRawOutput;
  const rawDirectory =
    isRecord(part.input) && isString(part.input.directory)
      ? part.input.directory
      : isRecord(part.input) && isString(part.input.path)
        ? part.input.path
        : null;
  const pattern =
    isRecord(part.input) && isString(part.input.pattern)
      ? part.input.pattern
      : null;
  const directory =
    rawDirectory === "." && projectPath ? projectPath : rawDirectory;
  const label = pattern ?? directory ?? "files";
  const displayLabel = label === "files" && isRunning ? "Listing" : label;
  const Icon = pattern ? SearchIcon : FolderIcon;

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(true);
    }
  }, [defaultExpanded]);

  const sortedChildren = useMemo(() => {
    if (!root) return [];
    return [...root.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }, [root]);

  return (
    <div className={expanded ? "w-full" : undefined}>
      <ChipButton
        className={cn(
          canExpand && "cursor-pointer",
          isRunning && "animate-pulse",
        )}
        hasError={hasError}
        onClick={() => canExpand && setExpanded(!expanded)}
        aria-label={displayLabel}
        tone="amber"
        type="button"
      >
        <Icon className="size-3.5 shrink-0" />
        {!isRunning ? (
          <>
            <span className="max-w-56 truncate font-medium">
              {displayLabel}
            </span>
            {hasOutput ? (
              <span className={CHIP_SUBTEXT_CLASSES}>
                {count} {count === 1 ? "file" : "files"}
              </span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>error</span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <div
          className={getExpandedChipClasses("amber", hasError)}
          style={{ borderColor: "currentColor" }}
        >
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive/10 p-3 text-destructive text-xs">
              {part.errorText}
            </pre>
          ) : null}
          {hasOutput ? (
            <FileTree
              className="text-xs"
              defaultExpanded={defaultExpandedFolders}
            >
              {sortedChildren.map((child) => (
                <FileTreeNodeView key={child.path} node={child} />
              ))}
            </FileTree>
          ) : hasRawOutput ? (
            <JsonBlock value={output} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// ── Chip-based tool components ─────────────────────────────────────────
