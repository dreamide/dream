import { FileDiff, type FileDiffProps } from "@pierre/diffs/react";
import { useTheme } from "next-themes";
import { useMemo } from "react";
import { cn } from "@/lib/utils";

type DiffViewMode = "unified" | "split";
type PierreDiffOptions = NonNullable<FileDiffProps<undefined>["options"]>;
type ParsedFileDiff = FileDiffProps<undefined>["fileDiff"];

const DIFF_UNMODIFIED_LINES_CSS = `
[data-separator='line-info'] {
  margin-block: 0;
  background-color: var(--color-muted);
}

[data-separator='line-info'] [data-separator-wrapper],
[data-separator='line-info'] [data-expand-button],
[data-separator='line-info'] [data-separator-content] {
  background-color: var(--color-muted);
}

[data-separator='line-info'] [data-separator-content] {
  padding-inline: 0;
}

[data-separator='line-info'] [data-expand-button] {
  border-right-color: transparent;
}

[data-separator='line-info'] [data-expand-up],
[data-separator='line-info'] [data-expand-down] {
  border-color: transparent;
}
`;

export const IdeDiffViewer = ({
  className,
  diffStyle = "unified",
  fileDiff,
}: {
  className?: string;
  diffStyle?: DiffViewMode;
  fileDiff: ParsedFileDiff;
}) => {
  const { resolvedTheme } = useTheme();
  const diffOptions = useMemo<PierreDiffOptions>(
    () => ({
      diffIndicators: "bars",
      diffStyle,
      disableFileHeader: true,
      hunkSeparators: "line-info",
      lineDiffType: "none",
      theme: {
        dark: "github-dark",
        light: "github-light",
      },
      themeType: resolvedTheme === "dark" ? "dark" : "light",
      unsafeCSS: DIFF_UNMODIFIED_LINES_CSS,
    }),
    [diffStyle, resolvedTheme],
  );

  return (
    <div className={cn("dream-diff-surface", className)}>
      <FileDiff
        className="dream-diff-viewer w-full min-w-0"
        fileDiff={fileDiff}
        options={diffOptions}
      />
    </div>
  );
};
