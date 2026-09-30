import { FolderIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  describeList,
  getToolCallSource,
  type ToolLikePart,
} from "../../assistant-message-tools";
import {
  buildFileTree,
  CHIP_ERROR_SUBTEXT_CLASSES,
  CHIP_SUBTEXT_CLASSES,
  ChipButton,
  ChipContent,
  FileTree,
  FileTreeNodeView,
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
  const assistantT = useTranslations("assistant");
  const commonT = useTranslations("common");
  const [expanded, setExpanded] = useState(defaultExpanded);
  const output = part.output;
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming";
  const hasError = isString(part.errorText) && part.errorText.length > 0;

  const {
    count,
    directory: rawDirectory,
    files,
    pattern,
  } = useMemo(() => describeList(getToolCallSource(part)), [part]);

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
  const directory =
    rawDirectory === "." && projectPath ? projectPath : rawDirectory;
  const filesLabel = commonT("files");
  const label = pattern ?? directory ?? filesLabel;
  const displayLabel =
    label === filesLabel && isRunning ? assistantT("listing") : label;
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
                {assistantT(count === 1 ? "fileCountOne" : "fileCountOther", {
                  count,
                })}
              </span>
            ) : null}
            {hasError ? (
              <span className={CHIP_ERROR_SUBTEXT_CLASSES}>
                {assistantT("error")}
              </span>
            ) : null}
          </>
        ) : null}
      </ChipButton>
      {expanded ? (
        <ChipContent hasError={hasError} tone="amber">
          {hasError ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-destructive-surface p-3 text-destructive text-xs">
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
        </ChipContent>
      ) : null}
    </div>
  );
};

// ── Chip-based tool components ─────────────────────────────────────────
