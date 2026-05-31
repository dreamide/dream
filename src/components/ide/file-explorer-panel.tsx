import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import { FileIcon, Files, RotateCw } from "lucide-react";
import type { CSSProperties } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Spinner } from "@/components/ui/spinner";
import { getDesktopApi } from "@/lib/electron";
import { AppShellPlaceholder, PanelResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { useMaterialFileTreeIcons } from "./material-file-icon";
import { RightPanelHeaderIconButton } from "./right-panel-header-icon-button";

const PROJECT_FILE_LIST_MAX_RESULTS = 2000;
const FILE_TREE_MIN_WIDTH_PX = 250;
const FILE_TREE_MAX_WIDTH_RATIO = 0.5;
const FILE_TREE_ITEM_HEIGHT_PX = 24;

export interface FileExplorerPanelProps {
  active?: boolean;
  onClosePanel: () => void;
  projectId?: string | null;
}

type ProjectFilesListResponse = {
  count: number;
  files: string[];
};

type ProjectFileReadResponse = {
  content: string;
  filePath: string;
};

interface ProjectFileTreeProps {
  files: string[];
  selectedFilePath: string | null;
  onSelectFile: (path: string | null) => void;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
]);

const isImageFile = (filePath: string): boolean => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(extension);
};

const inferLanguage = (filePath: string): BundledLanguage => {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  const languages: Record<string, BundledLanguage> = {
    c: "c",
    cpp: "cpp",
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rs: "rust",
    sh: "bash",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    txt: "log",
    yml: "yaml",
    yaml: "yaml",
  };

  return languages[extension] ?? "log";
};

const readResponseText = async (response: Response): Promise<string> => {
  const text = await response.text();
  return text.trim() || `Request failed (${response.status}).`;
};

const isMissingPathError = (message: string | null) =>
  Boolean(message && /ENOENT|no such file or directory/i.test(message));

const getInitialExpandedFileTreePaths = (files: string[]) => {
  const expanded = new Set<string>();

  for (const filePath of files) {
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    if (parts.length > 1) {
      expanded.add(`${parts[0]}/`);
    }
  }

  return [...expanded];
};

const FILE_TREE_UNSAFE_CSS = `
  :host {
    font-size: 12px;
    line-height: 18px;
  }

  [data-type="item"] {
    border: 0;
    border-radius: 4px;
    box-shadow: none;
    font-family: var(--trees-font-family);
    outline: none;
  }

  [data-type="item"]::before,
  [data-type="item"][data-item-focused="true"]::before,
  [data-type="item"][data-item-selected="true"]::before,
  [data-type="item"]:focus-visible::before {
    content: none;
    display: none;
    border: 0;
    box-shadow: none;
    outline: none;
  }

  [data-file-tree-search-container] {
    padding: 12px 24px 8px;
  }

  [data-file-tree-search-input] {
    appearance: none;
    box-sizing: border-box;
    width: 100%;
    height: 36px;
    min-width: 0;
    margin: 0;
    border: 1px solid var(--input);
    border-radius: 6px;
    background-color: transparent;
    background-clip: padding-box;
    padding: 4px 10px;
    color: var(--foreground);
    font-family: inherit;
    font-size: 14px;
    line-height: 20px;
    box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    transition-property: color, box-shadow;
    outline: none;
  }

  :host-context(.dark) [data-file-tree-search-input] {
    background-color: color-mix(in oklab, var(--input) 30%, transparent);
  }

  [data-file-tree-search-input]::placeholder {
    color: var(--muted-foreground);
  }

  [data-file-tree-search-input]:focus-visible,
  [data-file-tree-search-input][data-file-tree-search-input-fake-focus="true"] {
    border-color: var(--input);
    outline: none;
    box-shadow: 0 0 0 0 var(--ring);
  }

  [data-file-tree-virtualized-scroll]::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  [data-file-tree-virtualized-scroll]::-webkit-scrollbar-thumb {
    background-color: var(--trees-theme-scrollbar-thumb);
    border: 2px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
  }
`;

const fileTreeStyle = {
  "--trees-font-family-override":
    'var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  "--trees-focus-ring-offset-override": "0px",
  "--trees-focus-ring-width-override": "0px",
  "--trees-padding-inline-override": "24px",
  "--trees-search-bg-override": "var(--background)",
  "--trees-selected-focused-border-color-override": "transparent",
  "--trees-scrollbar-gutter-override": "10px",
  "--trees-theme-focus-ring": "var(--ring)",
  "--trees-theme-input-bg": "var(--background)",
  "--trees-theme-input-border": "var(--border)",
  "--trees-theme-list-active-selection-bg": "var(--accent)",
  "--trees-theme-list-active-selection-fg": "var(--accent-foreground)",
  "--trees-theme-list-hover-bg": "var(--accent)",
  "--trees-theme-scrollbar-thumb": "var(--border)",
  "--trees-theme-sidebar-bg": "var(--background)",
  "--trees-theme-sidebar-border": "var(--border)",
  "--trees-theme-sidebar-fg": "var(--foreground)",
  "--truncate-marker-background-color": "var(--background)",
  backgroundColor: "var(--background)",
  borderColor: "transparent",
  color: "var(--foreground)",
  colorScheme: "light dark",
  display: "block",
  height: "100%",
  width: "100%",
} as CSSProperties;

const ProjectFileTree = ({
  files,
  selectedFilePath,
  onSelectFile,
}: ProjectFileTreeProps) => {
  const fileSetRef = useRef(new Set(files));
  const onSelectFileRef = useRef(onSelectFile);
  const materialFileTreeIcons = useMaterialFileTreeIcons();

  useEffect(() => {
    fileSetRef.current = new Set(files);
  }, [files]);

  useEffect(() => {
    onSelectFileRef.current = onSelectFile;
  }, [onSelectFile]);

  const handleSelectionChange = useCallback(
    (selectedPaths: readonly string[]) => {
      const selectedPath = selectedPaths[0] ?? null;

      if (!selectedPath || !fileSetRef.current.has(selectedPath)) {
        onSelectFileRef.current(null);
        return;
      }

      onSelectFileRef.current(selectedPath);
    },
    [],
  );

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    icons: materialFileTreeIcons,
    initialExpandedPaths: getInitialExpandedFileTreePaths(files),
    initialSelectedPaths: selectedFilePath ? [selectedFilePath] : [],
    itemHeight: FILE_TREE_ITEM_HEIGHT_PX,
    onSelectionChange: handleSelectionChange,
    paths: files,
    search: true,
    searchBlurBehavior: "retain",
    stickyFolders: false,
    unsafeCSS: FILE_TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    model.setIcons(materialFileTreeIcons);
  }, [materialFileTreeIcons, model]);

  useEffect(() => {
    model.resetPaths(files, {
      initialExpandedPaths: getInitialExpandedFileTreePaths(files),
    });
  }, [files, model]);

  useEffect(() => {
    for (const path of model.getSelectedPaths()) {
      if (path !== selectedFilePath) {
        model.getItem(path)?.deselect();
      }
    }

    if (!selectedFilePath || !fileSetRef.current.has(selectedFilePath)) {
      return;
    }

    const item = model.getItem(selectedFilePath);
    item?.select();
    model.focusNearestPath(selectedFilePath);
  }, [model, selectedFilePath]);

  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const host = wrapper.querySelector("file-tree-container");
    const scrollEl = host?.shadowRoot?.querySelector<HTMLElement>(
      "[data-file-tree-virtualized-scroll]",
    );
    if (!scrollEl) return;

    const SCROLL_MULTIPLIER = 3;

    const handleWheel = (event: WheelEvent) => {
      // Only boost standard pixel-mode wheel events (deltaMode 0)
      if (event.deltaMode !== 0) return;
      event.preventDefault();
      scrollEl.scrollTop += event.deltaY * SCROLL_MULTIPLIER;
      scrollEl.scrollLeft += event.deltaX * SCROLL_MULTIPLIER;
    };

    scrollEl.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      scrollEl.removeEventListener("wheel", handleWheel);
    };
  }, []);

  return (
    <div ref={wrapperRef} className="h-full">
      <PierreFileTree
        aria-label="Project files"
        model={model}
        style={fileTreeStyle}
      />
    </div>
  );
};

const FileExplorerPanelImpl = ({
  active = true,
  onClosePanel,
  projectId: requestedProjectId,
}: FileExplorerPanelProps) => {
  const activeProject = useIdeStore((s) =>
    requestedProjectId
      ? (s.projects.find((project) => project.id === requestedProjectId) ??
        null)
      : s.getActiveProject(),
  );
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLDivElement | null>(null);
  const treeWidthRef = useRef<number | null>(null);
  const loadedFileListKeysRef = useRef(new Set<string>());
  const previousProjectFilesRefreshKeyByProjectRef = useRef<
    Record<string, number>
  >({});

  const [fileListsByProject, setFileListsByProject] = useState<
    Record<string, string[]>
  >({});
  const [selectedFileByProject, setSelectedFileByProject] = useState<
    Record<string, string | null>
  >({});
  const [fileContentsByProject, setFileContentsByProject] = useState<
    Record<string, Record<string, string>>
  >({});
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  const projectId = activeProject?.id ?? null;
  const projectPath = activeProject?.path ?? null;
  const projectFilesRefreshKey = useIdeStore((s) =>
    projectId ? (s.projectFilesRefreshKeys[projectId] ?? 0) : 0,
  );
  const fileOpenRequest = useIdeStore((s) =>
    projectId ? (s.projectFileOpenRequests[projectId] ?? null) : null,
  );
  const fileOpenRequestPath = fileOpenRequest?.filePath ?? null;
  const fileOpenRequestKey = fileOpenRequest
    ? `${fileOpenRequest.requestId}:${fileOpenRequest.filePath}`
    : "";
  const files = projectId ? (fileListsByProject[projectId] ?? []) : [];
  const selectedFilePath = projectId
    ? (selectedFileByProject[projectId] ?? null)
    : null;
  const selectedFileContent =
    projectId && selectedFilePath
      ? (fileContentsByProject[projectId]?.[selectedFilePath] ?? null)
      : null;
  const isMissingProjectPath = isMissingPathError(filesError);

  const loadProjectFiles = useCallback(async () => {
    if (!projectId || !projectPath) {
      return;
    }

    setFilesLoading(true);
    setFilesError(null);

    try {
      const response = await fetch("/api/project-files", {
        body: JSON.stringify({
          directory: ".",
          maxResults: PROJECT_FILE_LIST_MAX_RESULTS,
          projectPath,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      const payload = (await response.json()) as ProjectFilesListResponse;
      const nextFiles = payload.files;

      setFileListsByProject((current) => ({
        ...current,
        [projectId]: nextFiles,
      }));

      setSelectedFileByProject((current) => {
        const existingSelection = current[projectId] ?? null;
        if (existingSelection && nextFiles.includes(existingSelection)) {
          return current;
        }

        return {
          ...current,
          [projectId]: null,
        };
      });
    } catch (error) {
      setFilesError(
        error instanceof Error
          ? error.message
          : "Failed to load project files.",
      );
    } finally {
      setFilesLoading(false);
    }
  }, [projectId, projectPath]);

  const handleOpenProjectPath = useCallback(async () => {
    if (!projectPath) {
      return;
    }

    await getDesktopApi()?.openInEditor({
      editorId: "file-explorer",
      projectPath,
    });
  }, [projectPath]);

  const handleRefreshFiles = useCallback(() => {
    if (!projectId) {
      return;
    }
    useIdeStore.getState().bumpProjectFilesRefreshKey(projectId);
  }, [projectId]);

  useEffect(() => {
    void projectFilesRefreshKey;
    if (!active) {
      return;
    }

    if (!projectId || !projectPath) {
      return;
    }

    const previousRefreshKey =
      previousProjectFilesRefreshKeyByProjectRef.current[projectId];
    const refreshChanged =
      previousRefreshKey !== undefined &&
      previousRefreshKey !== projectFilesRefreshKey;
    const fileListKey = `${projectId}:${projectPath}`;

    previousProjectFilesRefreshKeyByProjectRef.current[projectId] =
      projectFilesRefreshKey;

    if (loadedFileListKeysRef.current.has(fileListKey) && !refreshChanged) {
      return;
    }

    loadedFileListKeysRef.current.add(fileListKey);

    if (refreshChanged) {
      setFileContentsByProject((current) => {
        if (!current[projectId]) {
          return current;
        }

        const next = { ...current };
        delete next[projectId];
        return next;
      });
    }

    void loadProjectFiles();
  }, [
    active,
    loadProjectFiles,
    projectFilesRefreshKey,
    projectId,
    projectPath,
  ]);

  useEffect(() => {
    void fileOpenRequestKey;
    if (!active || !projectId || !fileOpenRequestPath) {
      return;
    }

    setSelectedFileByProject((current) => ({
      ...current,
      [projectId]: fileOpenRequestPath,
    }));
    setFileError(null);
  }, [active, fileOpenRequestKey, fileOpenRequestPath, projectId]);

  useEffect(() => {
    if (!active) {
      return;
    }

    if (!projectId || !projectPath || !selectedFilePath) {
      return;
    }

    if (isImageFile(selectedFilePath)) {
      return;
    }

    if (fileContentsByProject[projectId]?.[selectedFilePath]) {
      return;
    }

    let cancelled = false;

    const loadSelectedFile = async () => {
      setFileLoading(true);
      setFileError(null);

      try {
        const response = await fetch("/api/project-file", {
          body: JSON.stringify({
            filePath: selectedFilePath,
            projectPath,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        const payload = (await response.json()) as ProjectFileReadResponse;
        if (cancelled) {
          return;
        }

        setFileContentsByProject((current) => ({
          ...current,
          [projectId]: {
            ...(current[projectId] ?? {}),
            [payload.filePath]: payload.content,
          },
        }));
      } catch (error) {
        if (!cancelled) {
          setFileError(
            error instanceof Error
              ? error.message
              : "Failed to read the selected file.",
          );
        }
      } finally {
        if (!cancelled) {
          setFileLoading(false);
        }
      }
    };

    void loadSelectedFile();

    return () => {
      cancelled = true;
    };
  }, [active, fileContentsByProject, projectId, projectPath, selectedFilePath]);

  const handleSelectFile = useCallback(
    (path: string | null) => {
      if (!projectId) {
        return;
      }

      setSelectedFileByProject((current) => ({
        ...current,
        [projectId]: path,
      }));
      setFileError(null);
    },
    [projectId],
  );

  const handleTreeResizeStart = useCallback(() => {
    treeWidthRef.current =
      treePaneRef.current?.getBoundingClientRect().width ??
      FILE_TREE_MIN_WIDTH_PX;
  }, []);

  const handleTreeResize = useCallback((deltaX: number) => {
    const containerWidth =
      splitContainerRef.current?.getBoundingClientRect().width ?? 0;
    const maxWidth = Math.max(
      FILE_TREE_MIN_WIDTH_PX,
      containerWidth * FILE_TREE_MAX_WIDTH_RATIO,
    );
    const nextWidth = Math.min(
      maxWidth,
      Math.max(
        FILE_TREE_MIN_WIDTH_PX,
        (treeWidthRef.current ?? FILE_TREE_MIN_WIDTH_PX) + deltaX,
      ),
    );

    treeWidthRef.current = nextWidth;
    if (treePaneRef.current) {
      treePaneRef.current.style.width = `${nextWidth}px`;
    }
  }, []);

  if (!activeProject) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex min-h-[50px] items-center gap-2 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2 text-sm font-medium">
          <RightPanelHeaderIconButton icon={Files} onClose={onClosePanel} />
          <span>Files</span>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <AppShellPlaceholder message="Add a project to browse its files." />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="grid min-h-[50px] grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <RightPanelHeaderIconButton icon={Files} onClose={onClosePanel} />
          <div className="truncate text-sm font-medium">Files</div>
        </div>
        <button
          className="min-w-0 max-w-full justify-self-center truncate rounded px-2 py-1 text-center text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 dark:focus-visible:ring-surface-500"
          onClick={handleOpenProjectPath}
          title="Open project folder"
          type="button"
        >
          {activeProject.path}
        </button>
        <button
          aria-label="Refresh files"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={handleRefreshFiles}
          title="Refresh files"
          type="button"
        >
          <RotateCw className="size-3.5" />
        </button>
      </div>

      <div ref={splitContainerRef} className="flex min-h-0 flex-1">
        {/* File tree */}
        <div
          ref={treePaneRef}
          className="shrink-0 overflow-hidden"
          style={{
            width: `${treeWidthRef.current ?? FILE_TREE_MIN_WIDTH_PX}px`,
            minWidth: FILE_TREE_MIN_WIDTH_PX,
            maxWidth: `${FILE_TREE_MAX_WIDTH_RATIO * 100}%`,
          }}
        >
          <div className="h-full border-r border-surface-200 dark:border-surface-800 bg-background">
            {!filesError && filesLoading && files.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <Spinner className="size-4 text-muted-foreground" />
              </div>
            ) : (
              <div className="h-full">
                {filesError ? (
                  <div className="p-3">
                    {isMissingProjectPath ? (
                      <div className="rounded-md border border-surface-200 dark:border-surface-800 bg-background px-3 py-3">
                        <div className="font-medium text-foreground text-sm">
                          Project folder not found.
                        </div>
                        {projectPath ? (
                          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                            {projectPath}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-xs">
                        {filesError}
                      </div>
                    )}
                  </div>
                ) : null}

                {!filesError && !filesLoading && files.length === 0 ? (
                  <div className="p-3">
                    <div className="text-muted-foreground text-sm">
                      No project files found.
                    </div>
                  </div>
                ) : null}

                {!filesError && files.length > 0 ? (
                  <ProjectFileTree
                    files={files}
                    onSelectFile={handleSelectFile}
                    selectedFilePath={selectedFilePath}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>

        <PanelResizeHandle
          side="right"
          onResize={handleTreeResize}
          onResizeStart={handleTreeResizeStart}
        />

        {/* File content */}
        <div className="min-w-0 flex-1 overflow-hidden">
          {!selectedFilePath ? (
            <div className="h-full p-3">
              <AppShellPlaceholder message="Select a file from the tree to open it here." />
            </div>
          ) : fileError ? (
            <div className="p-3">
              <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-sm">
                {fileError}
              </div>
            </div>
          ) : fileLoading && !selectedFileContent ? (
            <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
              <Spinner className="size-4" />
            </div>
          ) : isImageFile(selectedFilePath) ? (
            <div className="flex h-full items-center justify-center p-6">
              <img
                alt={selectedFilePath}
                className="max-h-full max-w-full object-contain"
                src={`/api/project-file-raw?projectPath=${encodeURIComponent(projectPath ?? "")}&filePath=${encodeURIComponent(selectedFilePath)}`}
              />
            </div>
          ) : selectedFileContent !== null ? (
            <div className="h-full">
              <CodeBlock
                className="flex h-full max-h-full flex-col overflow-hidden rounded-none border-0 shadow-none [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                code={selectedFileContent}
                deferUntilHighlighted
                language={inferLanguage(selectedFilePath)}
                showLineNumbers
                style={{ contentVisibility: "visible" }}
              >
                <CodeBlockHeader className="shrink-0 border-0 bg-transparent">
                  <CodeBlockTitle>
                    <FileIcon size={14} />
                    <CodeBlockFilename>{selectedFilePath}</CodeBlockFilename>
                  </CodeBlockTitle>
                  <CodeBlockActions>
                    <CodeBlockCopyButton />
                  </CodeBlockActions>
                </CodeBlockHeader>
              </CodeBlock>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};

export const FileExplorerPanel = memo(FileExplorerPanelImpl);
FileExplorerPanel.displayName = "FileExplorerPanel";
