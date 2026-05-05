import type { UIMessage } from "ai";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  Maximize2Icon,
  XIcon,
} from "lucide-react";
import type {
  ComponentProps,
  HTMLAttributes,
  ReactElement,
  ReactNode,
  RefObject,
} from "react";
import {
  cloneElement,
  createContext,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  extractTableDataFromElement,
  Streamdown,
  tableDataToCSV,
  tableDataToMarkdown,
  tableDataToTSV,
} from "streamdown";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StreamdownCodeBlock } from "@/components/ai-elements/streamdown-code-block";
import { streamdownPlugins } from "@/components/ai-elements/streamdown-plugins";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user"
        ? "is-user ml-auto max-w-[95%] justify-end"
        : "is-assistant max-w-full",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} title={tooltip} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(
  null,
);

const useMessageBranch = () => {
  const context = useContext(MessageBranchContext);

  if (!context) {
    throw new Error(
      "MessageBranch components must be used within MessageBranch",
    );
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  const goToPrevious = useCallback(() => {
    const newBranch =
      currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch =
      currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div
        className={cn("grid w-full gap-2 [&>div]:pb-0", className)}
        {...props}
      />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({
  children,
  ...props
}: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Use useEffect to update branches when they change
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({
  className,
  ...props
}: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Don't render if there's only one branch
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({
  children,
  ...props
}: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeftIcon size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({
  children,
  ...props
}: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRightIcon size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({
  className,
  ...props
}: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn(
        "border-none bg-transparent text-muted-foreground shadow-none",
        className,
      )}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

const codeFenceLanguageRegex = /(?:^|\s)language-([^\s]+)/;

const getTextContent = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(getTextContent).join("");
  }

  if (isValidElement<{ children?: unknown }>(value)) {
    return getTextContent(value.props.children);
  }

  return "";
};

const MessageCodePre = ({ children }: ComponentProps<"pre">) => {
  if (!isValidElement(children)) {
    return <pre>{children}</pre>;
  }

  const codeElement = children as ReactElement<{
    children?: unknown;
    className?: string;
  }>;
  const languageMatch = codeElement.props.className?.match(
    codeFenceLanguageRegex,
  );

  if (!languageMatch) {
    return (
      <StreamdownCodeBlock
        code={getTextContent(codeElement.props.children)}
        language=""
      />
    );
  }

  return cloneElement(codeElement, {
    "data-block": "true",
  } as Partial<typeof codeElement.props>);
};

type TableTextFormat = "csv" | "markdown" | "tsv";
type TableDownloadFormat = Exclude<TableTextFormat, "tsv">;

const TABLE_ACTION_BUTTON_CLASSES =
  "h-7 w-7 shrink-0 p-0 text-muted-foreground hover:text-foreground";

const getTableElement = (tableRef: RefObject<HTMLTableElement | null>) => {
  const table = tableRef.current;
  if (!table) {
    throw new Error("Table not found.");
  }

  return table;
};

const getTableText = (
  tableRef: RefObject<HTMLTableElement | null>,
  format: TableTextFormat,
) => {
  const data = extractTableDataFromElement(getTableElement(tableRef));

  if (format === "csv") {
    return tableDataToCSV(data);
  }

  if (format === "tsv") {
    return tableDataToTSV(data);
  }

  return tableDataToMarkdown(data);
};

const copyTextToClipboard = async (value: string) => {
  const desktopApi = getDesktopApi();
  if (desktopApi) {
    const copied = await desktopApi.writeClipboardText(value);
    if (!copied) {
      throw new Error("Clipboard copy failed.");
    }
    return;
  }

  if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
    throw new Error("Clipboard API not available.");
  }

  await navigator.clipboard.writeText(value);
};

const saveTableTextFile = async (
  format: TableDownloadFormat,
  contents: string,
) => {
  const extension = format === "csv" ? "csv" : "md";
  const filename = `table.${extension}`;
  const desktopApi = getDesktopApi();

  if (desktopApi) {
    await desktopApi.saveTextFile({
      contents,
      defaultPath: filename,
      title: "Save table",
    });
    return;
  }

  const mimeType = format === "csv" ? "text/csv" : "text/markdown";
  const blob = new Blob([contents], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

const MarkdownTableCopyMenu = ({
  tableRef,
}: {
  tableRef: RefObject<HTMLTableElement | null>;
}) => {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number>(0);

  const handleCopy = useCallback(
    async (format: TableTextFormat) => {
      await copyTextToClipboard(getTableText(tableRef, format));
      setCopied(true);
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 2000);
    },
    [tableRef],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = copied ? CheckIcon : CopyIcon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Copy table"
            className={TABLE_ACTION_BUTTON_CLASSES}
            size="icon-xs"
            title="Copy table"
            type="button"
            variant="ghost"
          />
        }
      >
        <Icon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handleCopy("markdown")}>
          Markdown
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleCopy("csv")}>
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleCopy("tsv")}>
          TSV
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const MarkdownTableDownloadMenu = ({
  tableRef,
}: {
  tableRef: RefObject<HTMLTableElement | null>;
}) => {
  const handleDownload = useCallback(
    async (format: TableDownloadFormat) => {
      await saveTableTextFile(format, getTableText(tableRef, format));
    },
    [tableRef],
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Download table"
            className={TABLE_ACTION_BUTTON_CLASSES}
            size="icon-xs"
            title="Download table"
            type="button"
            variant="ghost"
          />
        }
      >
        <DownloadIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => void handleDownload("csv")}>
          CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void handleDownload("markdown")}>
          Markdown
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const MarkdownTableFullscreenButton = ({
  children,
}: {
  children: ReactNode;
}) => {
  const [fullscreen, setFullscreen] = useState(false);
  const fullscreenTableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    if (!fullscreen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [fullscreen]);

  return (
    <>
      <Button
        aria-label="View fullscreen"
        className={TABLE_ACTION_BUTTON_CLASSES}
        onClick={() => setFullscreen(true)}
        size="icon-xs"
        title="View fullscreen"
        type="button"
        variant="ghost"
      >
        <Maximize2Icon className="size-3.5" />
      </Button>
      {fullscreen && typeof document !== "undefined"
        ? createPortal(
            <div
              aria-label="View fullscreen"
              aria-modal="true"
              className="fixed inset-0 z-50 flex flex-col bg-background"
              data-streamdown="table-fullscreen"
              onClick={() => setFullscreen(false)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFullscreen(false);
                }
              }}
              role="dialog"
            >
              <div
                className="flex h-full flex-col"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                role="presentation"
              >
                <div className="flex items-center justify-end gap-1 p-4">
                  <MarkdownTableCopyMenu tableRef={fullscreenTableRef} />
                  <MarkdownTableDownloadMenu tableRef={fullscreenTableRef} />
                  <Button
                    aria-label="Exit fullscreen"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                    onClick={() => setFullscreen(false)}
                    size="icon-sm"
                    title="Exit fullscreen"
                    type="button"
                    variant="ghost"
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
                <div className="flex-1 overflow-auto p-4 pt-0 [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10">
                  <table
                    className="w-full border-collapse border border-border"
                    data-streamdown="table"
                    ref={fullscreenTableRef}
                  >
                    {children}
                  </table>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
};

const MarkdownTable = memo(
  ({
    children,
    className,
    node: _node,
    ...props
  }: ComponentProps<"table"> & { node?: unknown }) => {
    const tableRef = useRef<HTMLTableElement>(null);

    return (
      <div
        className="my-4 flex flex-col gap-2 rounded-lg border border-border bg-sidebar p-2"
        data-streamdown="table-wrapper"
      >
        <div className="flex items-center justify-end gap-1">
          <MarkdownTableCopyMenu tableRef={tableRef} />
          <MarkdownTableDownloadMenu tableRef={tableRef} />
          <MarkdownTableFullscreenButton>
            {children}
          </MarkdownTableFullscreenButton>
        </div>
        <div className="border-collapse overflow-x-auto overflow-y-auto rounded-md border border-border bg-background">
          <table
            className={cn("w-full divide-y divide-border", className)}
            data-streamdown="table"
            ref={tableRef}
            {...props}
          >
            {children}
          </table>
        </div>
      </div>
    );
  },
);

MarkdownTable.displayName = "MarkdownTable";

const defaultMessageResponseComponents = {
  pre: MessageCodePre,
  table: MarkdownTable,
} as NonNullable<MessageResponseProps["components"]>;

export const MessageResponse = memo(
  ({ className, components, ...props }: MessageResponseProps) => {
    const mergedComponents = useMemo(
      () => ({ ...defaultMessageResponseComponents, ...components }),
      [components],
    );

    return (
      <Streamdown
        className={cn(
          "dream-markdown-code-size size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          className,
        )}
        components={mergedComponents}
        plugins={streamdownPlugins}
        {...props}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.animated === nextProps.animated &&
    prevProps.isAnimating === nextProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn(
      "mt-4 flex w-full items-center justify-between gap-4",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
