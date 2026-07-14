import { FileTree as PierreFileTree, useFileTree } from "@pierre/trees/react";
import { FileIcon, Files, Pencil, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { BundledLanguage } from "shiki";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContainer,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";
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

const FileCodeEditor = lazy(() => import("./file-code-editor"));

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

interface EditingFileState {
  filePath: string;
  originalContent: string;
  projectId: string;
  value: string;
}

const isFilePreviewUnavailableStatus = (status: number) =>
  status === 413 || status === 415;

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

const getProjectFileRawUrl = (projectPath: string, filePath: string) =>
  `/api/project-file-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(filePath)}`;

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
  const panelsT = useTranslations("panels");
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
  const selectionSyncFrameRef = useRef<number | null>(null);

  const syncSelectionFromModel = useCallback(() => {
    const selectedPath = model.getSelectedPaths()[0] ?? null;

    if (!selectedPath || !fileSetRef.current.has(selectedPath)) {
      onSelectFileRef.current(null);
      return;
    }

    onSelectFileRef.current(selectedPath);
  }, [model]);

  const scheduleSelectionSync = useCallback(() => {
    if (selectionSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionSyncFrameRef.current);
    }

    selectionSyncFrameRef.current = window.requestAnimationFrame(() => {
      selectionSyncFrameRef.current = null;
      syncSelectionFromModel();
    });
  }, [syncSelectionFromModel]);

  useEffect(
    () => () => {
      if (selectionSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(selectionSyncFrameRef.current);
      }
    },
    [],
  );

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
    <div
      ref={wrapperRef}
      className="h-full"
      onClickCapture={scheduleSelectionSync}
      onKeyUpCapture={scheduleSelectionSync}
    >
      <PierreFileTree
        aria-label={panelsT("projectFiles")}
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
  const commonT = useTranslations("common");
  const panelsT = useTranslations("panels");
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
  const saveOperationIdRef = useRef(0);

  const [fileListsByProject, setFileListsByProject] = useState<
    Record<string, string[]>
  >({});
  const [selectedFileByProject, setSelectedFileByProject] = useState<
    Record<string, string | null>
  >({});
  const [fileContentsByProject, setFileContentsByProject] = useState<
    Record<string, Record<string, string>>
  >({});
  const [filePreviewMessagesByProject, setFilePreviewMessagesByProject] =
    useState<Record<string, Record<string, string>>>({});
  const [selectedImagePreviewUrl, setSelectedImagePreviewUrl] = useState<
    string | null
  >(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileSaveError, setFileSaveError] = useState<string | null>(null);
  const [editingFile, setEditingFile] = useState<EditingFileState | null>(null);
  const selectedImagePreviewUrlRef = useRef<string | null>(null);

  const replaceSelectedImagePreviewUrl = useCallback((url: string | null) => {
    setSelectedImagePreviewUrl(url);

    const previousUrl = selectedImagePreviewUrlRef.current;
    if (previousUrl && previousUrl !== url) {
      URL.revokeObjectURL(previousUrl);
    }
    selectedImagePreviewUrlRef.current = url;
  }, []);

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
  const selectedFilePreviewMessage =
    projectId && selectedFilePath
      ? (filePreviewMessagesByProject[projectId]?.[selectedFilePath] ?? null)
      : null;
  const isEditing = Boolean(
    editingFile &&
      editingFile.projectId === projectId &&
      editingFile.filePath === selectedFilePath,
  );
  const hasEditorChanges = Boolean(
    editingFile &&
      isEditing &&
      editingFile.value !== editingFile.originalContent,
  );
  const isMissingProjectPath = isMissingPathError(filesError);

  useEffect(() => {
    if (
      !editingFile ||
      (editingFile.projectId === projectId &&
        editingFile.filePath === selectedFilePath)
    ) {
      return;
    }

    saveOperationIdRef.current += 1;
    setEditingFile(null);
    setFileSaveError(null);
    setFileSaving(false);
  }, [editingFile, projectId, selectedFilePath]);

  useEffect(
    () => () => {
      if (selectedImagePreviewUrlRef.current) {
        URL.revokeObjectURL(selectedImagePreviewUrlRef.current);
        selectedImagePreviewUrlRef.current = null;
      }
    },
    [],
  );

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
          : panelsT("failedToLoadProjectFiles"),
      );
    } finally {
      setFilesLoading(false);
    }
  }, [panelsT, projectId, projectPath]);

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
      setFilePreviewMessagesByProject((current) => {
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
    if (!projectId || !projectPath || !selectedFilePath) {
      return;
    }

    if (isImageFile(selectedFilePath)) {
      return;
    }

    if (fileContentsByProject[projectId]?.[selectedFilePath] !== undefined) {
      return;
    }

    if (
      filePreviewMessagesByProject[projectId]?.[selectedFilePath] !== undefined
    ) {
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

        if (isFilePreviewUnavailableStatus(response.status) && !cancelled) {
          const message = await readResponseText(response);
          setFilePreviewMessagesByProject((current) => ({
            ...current,
            [projectId]: {
              ...(current[projectId] ?? {}),
              [selectedFilePath]: message,
            },
          }));
          return;
        }

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
              : panelsT("failedToReadFile"),
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
  }, [
    fileContentsByProject,
    filePreviewMessagesByProject,
    panelsT,
    projectId,
    projectPath,
    selectedFilePath,
  ]);

  useEffect(() => {
    if (!projectId || !projectPath || !selectedFilePath) {
      replaceSelectedImagePreviewUrl(null);
      return;
    }

    if (!isImageFile(selectedFilePath)) {
      replaceSelectedImagePreviewUrl(null);
      return;
    }

    let cancelled = false;

    const loadSelectedImage = async () => {
      setFileLoading(true);
      setFileError(null);
      replaceSelectedImagePreviewUrl(null);

      try {
        const response = await fetch(
          getProjectFileRawUrl(projectPath, selectedFilePath),
        );

        if (!response.ok) {
          throw new Error(await readResponseText(response));
        }

        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        replaceSelectedImagePreviewUrl(objectUrl);
      } catch (error) {
        if (!cancelled) {
          setFileError(
            error instanceof Error
              ? error.message
              : panelsT("failedToReadImage"),
          );
        }
      } finally {
        if (!cancelled) {
          setFileLoading(false);
        }
      }
    };

    void loadSelectedImage();

    return () => {
      cancelled = true;
    };
  }, [
    panelsT,
    projectId,
    projectPath,
    replaceSelectedImagePreviewUrl,
    selectedFilePath,
  ]);

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

  const handleStartEditing = useCallback(() => {
    if (
      !projectId ||
      !projectPath ||
      !selectedFilePath ||
      selectedFileContent === null
    ) {
      return;
    }

    setFileSaveError(null);
    setEditingFile({
      filePath: selectedFilePath,
      originalContent: selectedFileContent,
      projectId,
      value: selectedFileContent,
    });
  }, [projectId, projectPath, selectedFileContent, selectedFilePath]);

  const handleCancelEditing = useCallback(() => {
    setEditingFile(null);
    setFileSaveError(null);
  }, []);

  const handleSaveEditing = useCallback(async () => {
    if (!editingFile || !projectPath || fileSaving) {
      return;
    }

    if (editingFile.value === editingFile.originalContent) {
      return;
    }

    const operationId = saveOperationIdRef.current + 1;
    saveOperationIdRef.current = operationId;
    setFileSaving(true);
    setFileSaveError(null);

    try {
      const response = await fetch("/api/project-file", {
        body: JSON.stringify({
          content: editingFile.value,
          expectedContent: editingFile.originalContent,
          filePath: editingFile.filePath,
          projectPath,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        throw new Error(await readResponseText(response));
      }

      const payload = (await response.json()) as ProjectFileReadResponse;
      setFileContentsByProject((current) => ({
        ...current,
        [editingFile.projectId]: {
          ...(current[editingFile.projectId] ?? {}),
          [payload.filePath]: payload.content,
        },
      }));
      useIdeStore.getState().bumpProjectGitRefreshKey(editingFile.projectId);

      if (saveOperationIdRef.current === operationId) {
        setEditingFile(null);
        setFileSaveError(null);
      }
    } catch (error) {
      if (saveOperationIdRef.current === operationId) {
        setFileSaveError(
          error instanceof Error ? error.message : panelsT("failedToSaveFile"),
        );
      }
    } finally {
      if (saveOperationIdRef.current === operationId) {
        setFileSaving(false);
      }
    }
  }, [editingFile, fileSaving, panelsT, projectPath]);

  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSaveEditing();
        return;
      }

      if (event.key === "Escape" && !fileSaving) {
        event.preventDefault();
        handleCancelEditing();
      }
    },
    [fileSaving, handleCancelEditing, handleSaveEditing],
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

  const hasNoProjectFiles = !filesError && !filesLoading && files.length === 0;

  if (!activeProject) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex min-h-[50px] items-center gap-2 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2 text-sm font-medium">
          <RightPanelHeaderIconButton icon={Files} onClose={onClosePanel} />
          <span>{commonT("files")}</span>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <AppShellPlaceholder message={panelsT("addProjectForFiles")} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="grid min-h-[50px] grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <RightPanelHeaderIconButton icon={Files} onClose={onClosePanel} />
          <div className="truncate text-sm font-medium">{commonT("files")}</div>
        </div>
        <button
          className="min-w-0 max-w-full justify-self-center truncate rounded px-2 py-1 text-center text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-surface-400 dark:focus-visible:ring-surface-500"
          onClick={handleOpenProjectPath}
          title={commonT("open")}
          type="button"
        >
          {activeProject.path}
        </button>
        <button
          aria-label={panelsT("refreshFiles")}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={handleRefreshFiles}
          title={panelsT("refreshFiles")}
          type="button"
        >
          <RotateCw className="size-3.5" />
        </button>
      </div>

      {hasNoProjectFiles ? (
        <div className="min-h-0 flex-1 p-3">
          <AppShellPlaceholder message={panelsT("noProjectFiles")} />
        </div>
      ) : (
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
                            {panelsT("projectFolderNotFound")}
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
                <AppShellPlaceholder message={panelsT("selectFileToOpen")} />
              </div>
            ) : selectedFilePreviewMessage ? (
              <div className="h-full p-3">
                <AppShellPlaceholder message={selectedFilePreviewMessage} />
              </div>
            ) : fileError ? (
              <div className="p-3">
                <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-sm">
                  {fileError}
                </div>
              </div>
            ) : fileLoading &&
              (isImageFile(selectedFilePath)
                ? !selectedImagePreviewUrl
                : !selectedFileContent) ? (
              <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
                <Spinner className="size-4" />
              </div>
            ) : isImageFile(selectedFilePath) ? (
              selectedImagePreviewUrl ? (
                <div className="flex h-full items-center justify-center p-6">
                  <img
                    alt={selectedFilePath}
                    className="max-h-full max-w-full object-contain"
                    src={selectedImagePreviewUrl}
                  />
                </div>
              ) : null
            ) : selectedFileContent !== null ? (
              isEditing && editingFile ? (
                <CodeBlockContainer
                  className="flex h-full max-h-full flex-col overflow-hidden rounded-none border-0 shadow-none"
                  language={inferLanguage(selectedFilePath)}
                  onKeyDownCapture={handleEditorKeyDown}
                  style={{ contentVisibility: "visible" }}
                >
                  <CodeBlockHeader className="shrink-0 border-0 bg-transparent">
                    <CodeBlockTitle className="min-w-0">
                      <FileIcon className="shrink-0" size={14} />
                      <CodeBlockFilename className="truncate">
                        {selectedFilePath}
                      </CodeBlockFilename>
                    </CodeBlockTitle>
                    <CodeBlockActions className="shrink-0">
                      <Button
                        disabled={fileSaving}
                        onClick={handleCancelEditing}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        {commonT("cancel")}
                      </Button>
                      <Button
                        disabled={fileSaving || !hasEditorChanges}
                        onClick={() => void handleSaveEditing()}
                        size="xs"
                        type="button"
                      >
                        {fileSaving ? <Spinner className="size-3" /> : null}
                        {commonT("save")}
                      </Button>
                    </CodeBlockActions>
                  </CodeBlockHeader>
                  <div className="flex min-h-0 flex-1 flex-col">
                    {fileSaveError ? (
                      <div className="shrink-0 border-destructive-border border-b bg-destructive-surface-muted px-3 py-2 text-destructive text-xs">
                        {fileSaveError}
                      </div>
                    ) : null}
                    <div className="min-h-0 flex-1">
                      <Suspense
                        fallback={
                          <div className="flex h-full items-center justify-center">
                            <Spinner className="size-4 text-muted-foreground" />
                          </div>
                        }
                      >
                        <FileCodeEditor
                          disabled={fileSaving}
                          filePath={selectedFilePath}
                          onChange={(value) =>
                            setEditingFile((current) =>
                              current ? { ...current, value } : current,
                            )
                          }
                          value={editingFile.value}
                        />
                      </Suspense>
                    </div>
                  </div>
                </CodeBlockContainer>
              ) : (
                <div className="h-full">
                  <CodeBlock
                    className="flex h-full max-h-full flex-col overflow-hidden rounded-none border-0 shadow-none [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1"
                    code={selectedFileContent}
                    language={inferLanguage(selectedFilePath)}
                    showLineNumbers
                    style={{ contentVisibility: "visible" }}
                  >
                    <CodeBlockHeader className="shrink-0 border-0 bg-transparent">
                      <CodeBlockTitle>
                        <FileIcon size={14} />
                        <CodeBlockFilename>
                          {selectedFilePath}
                        </CodeBlockFilename>
                      </CodeBlockTitle>
                      <CodeBlockActions>
                        <CodeBlockCopyButton />
                        <Button
                          onClick={handleStartEditing}
                          size="xs"
                          type="button"
                          variant="ghost"
                        >
                          <Pencil />
                          {commonT("edit")}
                        </Button>
                      </CodeBlockActions>
                    </CodeBlockHeader>
                  </CodeBlock>
                </div>
              )
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};

export const FileExplorerPanel = memo(FileExplorerPanelImpl);
FileExplorerPanel.displayName = "FileExplorerPanel";
