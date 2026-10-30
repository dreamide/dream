import {
  FileTree as PierreFileTree,
  useFileTree,
  useFileTreeSearch,
} from "@pierre/trees/react";
import {
  FileIcon,
  Files,
  RotateCw,
  Save,
  Search,
  TextSearch,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { BundledLanguage } from "shiki";
import {
  CodeBlockContainer,
  CodeBlockCopyButton,
} from "@/components/ai-elements/code-block";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  apiClient,
  fetchApiBlob,
  getApiErrorMessage,
  getProjectFileRawUrl,
} from "@/lib/api-client";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { isBufferDirty } from "./file-buffers";
import {
  EMPTY_FILE_EDITOR_SNAPSHOT,
  type FileEditorSnapshot,
  isImageFile,
} from "./file-editor-session";
import { AppShellPlaceholder, PanelResizeHandle } from "./ide-helpers";
import { fileEditorSessions, useIdeStore } from "./ide-store";
import { useMaterialFileTreeIcons } from "./material-file-icon";
import { ProjectFileTree as ProjectFileTreeModule } from "./project-file-tree";
import { projectResourceKey, readProjectResource } from "./project-resources";
import { ProjectSearchView } from "./project-search-view";
import { RightPanelExpandButton } from "./right-panel-expand-button";
import { RightPanelHeaderIconButton } from "./right-panel-header-icon-button";
import { useShortcutMatcher } from "./shortcuts/shortcuts";
import { type StandardTabItem, StandardTabs } from "./standard-tabs";
import type { ProjectFilePosition } from "./store/ide-store-types";
import { WordWrapToggle } from "./word-wrap-toggle";

const FILE_TREE_MIN_WIDTH_PX = 250;
const FILE_TREE_MAX_WIDTH_RATIO = 0.5;
const FILE_TREE_ITEM_HEIGHT_PX = 24;
// Flat path index used to back tree search. Paths only, gitignore-aware, and
// fetched at most once per project until the panel is refreshed.
const PROJECT_SEARCH_INDEX_LIMIT = 50_000;

const FileCodeEditor = lazy(() => import("./file-code-editor"));

export interface FileExplorerPanelProps {
  active?: boolean;
  expanded?: boolean;
  onClosePanel: () => void;
  onToggleExpanded?: () => void;
  projectId?: string | null;
}

/** What the tree column shows: the file tree, or find in files. */
type FileTreeMode = "files" | "search";

interface ProjectFileTreeProps {
  active: boolean;
  onSelectedFileMissing: (path: string) => void;
  projectPath: string;
  refreshVersion: number;
  selectedFilePath: string | null;
  onSelectFile: (path: string | null) => void;
  // Fired on double-click / Enter. Mirrors VS Code: a single click previews
  // the file in a reusable tab, while this promotes it to a persistent tab.
  onPinFile: (path: string) => void;
  /**
   * The panel's toolbar row to render the filter input into, while the tree
   * is the visible mode; null otherwise.
   */
  toolbarSlot: HTMLElement | null;
}

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

const isMissingPathError = (message: string | null) =>
  Boolean(message && /ENOENT|no such file or directory/i.test(message));

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
  active,
  onPinFile,
  onSelectedFileMissing,
  onSelectFile,
  projectPath,
  refreshVersion,
  selectedFilePath,
  toolbarSlot,
}: ProjectFileTreeProps) => {
  const panelsT = useTranslations("panels");
  const materialFileTreeIcons = useMaterialFileTreeIcons();
  // The latest props, for the tree model's listeners, which are bound once.
  const latest = useRef({
    onPinFile,
    onSelectedFileMissing,
    onSelectFile,
    selectedFilePath,
  });
  latest.current = {
    onPinFile,
    onSelectedFileMissing,
    onSelectFile,
    selectedFilePath,
  };
  const treeRef = useRef<ProjectFileTreeModule | null>(null);

  /** Tells the panel when the tree's selection names another file. */
  const followSelection = useCallback((selectedTreePath?: string | null) => {
    const { onSelectFile: select, selectedFilePath: current } = latest.current;
    const next = treeRef.current?.selectedFile(current, selectedTreePath);
    if (next !== undefined && next !== current) {
      select(next);
    }
  }, []);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    icons: materialFileTreeIcons,
    initialExpansion: "closed",
    itemHeight: FILE_TREE_ITEM_HEIGHT_PX,
    onSearchChange: (value) => treeRef.current?.searchChanged(value),
    onSelectionChange: (selectedPaths) =>
      followSelection(selectedPaths[0] ?? null),
    paths: [],
    // The built-in search input (`search: true`) is intentionally disabled:
    // it closes the search on blur regardless of `searchBlurBehavior`. We
    // render our own input bound to the model via useFileTreeSearch instead,
    // so the filter persists until the user explicitly clears it.
    search: false,
    stickyFolders: false,
    unsafeCSS: FILE_TREE_UNSAFE_CSS,
  });

  const treeSearch = useFileTreeSearch(model);

  // Loading, expansion, the filter's path injection and reveals
  // (project-file-tree.ts).
  const tree = useMemo(
    () =>
      new ProjectFileTreeModule({
        fetchDirectory: (directory) =>
          apiClient.projectDirectory({ directory, projectPath }),
        // The project's file list from the project resources, shared with
        // the composer's `@` menu (which takes a prefix of it).
        fetchFiles: async () => {
          const payload = await readProjectResource(
            projectResourceKey("projectFiles", projectPath, {
              params: { maxResults: PROJECT_SEARCH_INDEX_LIMIT },
            }),
          );
          return payload.files ?? [];
        },
        model,
      }),
    [model, projectPath],
  );
  treeRef.current = tree;
  const { directoryErrors, rootStatus } = useSyncExternalStore(
    tree.subscribe,
    tree.getSnapshot,
  );

  useEffect(() => {
    model.setIcons(materialFileTreeIcons);
  }, [materialFileTreeIcons, model]);

  useEffect(() => {
    tree.attach();
    return () => tree.detach();
  }, [tree]);

  useEffect(() => {
    if (active) {
      tree.load(refreshVersion);
    }
  }, [active, refreshVersion, tree]);

  useEffect(() => {
    void refreshVersion;
    tree.deselectOthers(selectedFilePath);
    if (!active || !selectedFilePath) {
      return;
    }

    let cancelled = false;
    void tree.reveal(selectedFilePath).then((outcome) => {
      if (outcome === "missing" && !cancelled) {
        latest.current.onSelectedFileMissing(selectedFilePath);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [active, refreshVersion, selectedFilePath, tree]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const selectionSyncFrameRef = useRef<number | null>(null);

  const syncSelectionFromModel = useCallback(
    () => followSelection(),
    [followSelection],
  );

  const pinSelectedFile = useCallback(() => {
    const selected = tree.selectedFile(null);
    if (selected) {
      latest.current.onPinFile(selected);
    }
  }, [tree]);

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

  const nestedErrors = Object.entries(directoryErrors).filter(
    ([directory]) => directory !== ".",
  );

  const toolbar = toolbarSlot
    ? createPortal(
        <SearchInput
          aria-label={panelsT("searchFiles")}
          clearLabel={panelsT("clearSearch")}
          disabled={rootStatus !== "ready"}
          onClear={() => treeSearch.close()}
          onValueChange={(value) => {
            if (treeSearch.isOpen) {
              treeSearch.setValue(value);
            } else {
              treeSearch.open(value);
            }
          }}
          placeholder={panelsT("searchFiles")}
          value={treeSearch.isOpen ? treeSearch.value : ""}
        />,
        toolbarSlot,
      )
    : null;

  if (rootStatus !== "ready") {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="min-h-0 flex-1">
          <ProjectFileTreeStatus
            directoryErrors={directoryErrors}
            projectPath={projectPath}
            rootStatus={rootStatus}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={wrapperRef}
      className="flex h-full flex-col"
      onClickCapture={scheduleSelectionSync}
      onDoubleClickCapture={pinSelectedFile}
      onKeyUpCapture={(event) => {
        scheduleSelectionSync();
        if (
          event.key === "Enter" &&
          !(event.target instanceof HTMLInputElement)
        ) {
          pinSelectedFile();
        }
      }}
    >
      {toolbar}
      {nestedErrors.length > 0 ? (
        <div className="shrink-0 space-y-1 p-2 pb-0">
          {nestedErrors.map(([directory, message]) => (
            <div
              className="flex items-center gap-2 rounded-md border border-destructive-border bg-destructive-surface-muted px-2 py-1.5 text-destructive text-xs"
              key={directory}
            >
              <span className="min-w-0 flex-1 truncate" title={message}>
                {directory}: {message}
              </span>
              <button
                aria-label={panelsT("retryDirectory", { directory })}
                className="shrink-0 rounded p-0.5 hover:bg-destructive/10"
                onClick={() => tree.retry(directory)}
                type="button"
              >
                <RotateCw className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <PierreFileTree
          aria-label={panelsT("projectFiles")}
          model={model}
          style={fileTreeStyle}
        />
      </div>
    </div>
  );
};

/** What the tree shows in place of its files while they are not ready. */
const ProjectFileTreeStatus = ({
  directoryErrors,
  projectPath,
  rootStatus,
}: {
  directoryErrors: Record<string, string>;
  projectPath: string;
  rootStatus: "idle" | "loading" | "empty" | "error";
}) => {
  const panelsT = useTranslations("panels");

  if (rootStatus === "idle" || rootStatus === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-4 text-muted-foreground" />
      </div>
    );
  }

  if (rootStatus === "error") {
    const rootError =
      directoryErrors["."] ?? panelsT("failedToLoadProjectFiles");
    return (
      <div className="px-3 pb-3">
        {isMissingPathError(rootError) ? (
          <div className="rounded-md border border-surface-200 dark:border-surface-800 bg-background px-3 py-3">
            <div className="font-medium text-foreground text-sm">
              {panelsT("projectFolderNotFound")}
            </div>
            <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
              {projectPath}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-destructive-border bg-destructive-surface-muted px-3 py-2 text-destructive text-xs">
            {rootError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-full px-3 pb-3">
      <AppShellPlaceholder message={panelsT("noProjectFiles")} />
    </div>
  );
};

const noSubscription = () => () => {};
const emptySnapshot = (): FileEditorSnapshot => EMPTY_FILE_EDITOR_SNAPSHOT;

/** The project's file editor session and its current snapshot. */
const useFileEditorSession = (projectId: string | null) => {
  const session = projectId ? fileEditorSessions.session(projectId) : null;
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.getSnapshot ?? emptySnapshot,
  );
  return { session, snapshot };
};

const FileExplorerPanelImpl = ({
  active = true,
  expanded = false,
  onClosePanel,
  onToggleExpanded,
  projectId: requestedProjectId,
}: FileExplorerPanelProps) => {
  const commonT = useTranslations("common");
  const fileSearchT = useTranslations("fileSearch");
  const panelsT = useTranslations("panels");
  const uiT = useTranslations("ui");
  const activeProject = useIdeStore((s) =>
    requestedProjectId
      ? (s.projects.find((project) => project.id === requestedProjectId) ??
        null)
      : s.getActiveProject(),
  );
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const treePaneRef = useRef<HTMLDivElement | null>(null);
  const treeWidthRef = useRef<number | null>(null);

  const projectId = activeProject?.id ?? null;
  const projectPath = activeProject?.path ?? null;
  const { session, snapshot } = useFileEditorSession(projectId);
  const [selectedImagePreviewUrl, setSelectedImagePreviewUrl] = useState<
    string | null
  >(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [editorSearchRequest, setEditorSearchRequest] = useState(0);
  const [isEditorSearchOpen, setIsEditorSearchOpen] = useState(false);
  const [treeMode, setTreeMode] = useState<FileTreeMode>("files");
  const [treeToolbarSlot, setTreeToolbarSlot] = useState<HTMLDivElement | null>(
    null,
  );
  const [projectSearchFocusRequest, setProjectSearchFocusRequest] = useState(0);
  const selectedImagePreviewUrlRef = useRef<string | null>(null);

  const replaceSelectedImagePreviewUrl = useCallback((url: string | null) => {
    setSelectedImagePreviewUrl(url);

    const previousUrl = selectedImagePreviewUrlRef.current;
    if (previousUrl && previousUrl !== url) {
      URL.revokeObjectURL(previousUrl);
    }
    selectedImagePreviewUrlRef.current = url;
  }, []);

  const wordWrapEnabled = activeProject?.ui.fileEditorWordWrap ?? true;
  const projectFilesRefreshKey = useIdeStore((s) =>
    projectId ? (s.projectFilesRefreshKeys[projectId] ?? 0) : 0,
  );
  const fileSearchRequest = useIdeStore((s) =>
    projectId ? (s.projectFileSearchRequests[projectId] ?? 0) : 0,
  );

  // The session keeps errors as thrown; this puts them into words.
  const describeError = useCallback(
    (error: unknown, fallback: string) =>
      typeof error === "string"
        ? error
        : getApiErrorMessage(error, fallback, (status) =>
            uiT("requestFailedStatus", { status }),
          ),
    [uiT],
  );

  const selectedFilePath = snapshot.activePath;
  const selectedFileIsImage = selectedFilePath
    ? isImageFile(selectedFilePath)
    : false;
  const selectedFileBuffer = selectedFilePath
    ? (snapshot.buffers[selectedFilePath] ?? null)
    : null;
  const selectedFileRead = selectedFilePath
    ? (snapshot.reads[selectedFilePath] ?? null)
    : null;
  const selectedFileMetadata = selectedFileRead?.metadata ?? null;
  const selectedFileIsDirty = isBufferDirty(selectedFileBuffer);
  // Too large or binary: a notice in place of the preview, not an error.
  const selectedFilePreviewMessage =
    selectedFileRead?.status === "unavailable"
      ? describeError(selectedFileRead.error, panelsT("failedToReadFile"))
      : null;
  const fileError = selectedFileIsImage
    ? imageError
    : selectedFileRead?.status === "failed"
      ? describeError(selectedFileRead.error, panelsT("failedToReadFile"))
      : null;
  const fileLoading = selectedFileIsImage
    ? imageLoading
    : selectedFileRead?.status === "loading";
  const selectedFileReveal =
    snapshot.reveal && snapshot.reveal.path === selectedFilePath
      ? snapshot.reveal
      : null;

  useEffect(
    () => () => {
      if (selectedImagePreviewUrlRef.current) {
        URL.revokeObjectURL(selectedImagePreviewUrlRef.current);
        selectedImagePreviewUrlRef.current = null;
      }
    },
    [],
  );

  const handleOpenProjectPath = useCallback(async () => {
    if (!projectPath) {
      return;
    }

    // A folder on an SSH host is not on this machine: main refuses it.
    const state = useIdeStore.getState();
    const hostId = [...state.projects, ...state.closedProjects].find(
      (project) => project.id === projectId,
    )?.hostId;
    await getDesktopApi()?.openInEditor({
      hostId,
      editorId: "file-explorer",
      projectPath,
      sshTarget: hostId
        ? state.settings.sshHosts.find((host) => host.id === hostId)?.target
        : undefined,
    });
  }, [projectId, projectPath]);

  const handleWordWrapChange = useCallback(
    (enabled: boolean) => {
      if (!projectId) {
        return;
      }

      useIdeStore.getState().updateProject(projectId, (project) => ({
        ...project,
        ui: {
          ...project.ui,
          fileEditorWordWrap: enabled,
        },
      }));
    },
    [projectId],
  );

  const handledFileSearchRequestRef = useRef(0);
  useEffect(() => {
    if (!active || fileSearchRequest === handledFileSearchRequestRef.current) {
      return;
    }
    handledFileSearchRequestRef.current = fileSearchRequest;
    setTreeMode("search");
    setProjectSearchFocusRequest((current) => current + 1);
  }, [active, fileSearchRequest]);

  const handleTreeModeChange = useCallback((mode: FileTreeMode) => {
    setTreeMode(mode);
    if (mode === "search") {
      setProjectSearchFocusRequest((current) => current + 1);
    }
  }, []);

  useEffect(() => {
    if (!projectPath || !selectedFilePath || !selectedFileIsImage) {
      replaceSelectedImagePreviewUrl(null);
      setImageError(null);
      return;
    }

    let cancelled = false;

    const loadSelectedImage = async () => {
      setImageLoading(true);
      setImageError(null);
      replaceSelectedImagePreviewUrl(null);

      try {
        const blob = await fetchApiBlob(
          getProjectFileRawUrl(projectPath, selectedFilePath),
        );
        const objectUrl = URL.createObjectURL(blob);

        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }

        replaceSelectedImagePreviewUrl(objectUrl);
      } catch (error) {
        if (!cancelled) {
          setImageError(describeError(error, panelsT("failedToReadImage")));
        }
      } finally {
        if (!cancelled) {
          setImageLoading(false);
        }
      }
    };

    void loadSelectedImage();

    return () => {
      cancelled = true;
    };
  }, [
    describeError,
    panelsT,
    projectPath,
    replaceSelectedImagePreviewUrl,
    selectedFileIsImage,
    selectedFilePath,
  ]);

  const resetEditorChrome = useCallback(() => {
    setEditorSearchRequest(0);
    setIsEditorSearchOpen(false);
  }, []);

  const handleSelectFile = useCallback(
    (path: string | null) => {
      if (!session || !path) {
        return;
      }

      session.open(path);
      resetEditorChrome();
    },
    [resetEditorChrome, session],
  );

  const handlePinFile = useCallback(
    (path: string) => {
      if (!session) {
        return;
      }

      session.open(path, { pin: true });
      resetEditorChrome();
    },
    [resetEditorChrome, session],
  );

  const handleOpenSearchResult = useCallback(
    (
      path: string,
      position: ProjectFilePosition,
      { pin }: { pin: boolean },
    ) => {
      if (!session) {
        return;
      }

      session.open(path, { focus: pin, pin, position });
      resetEditorChrome();
    },
    [resetEditorChrome, session],
  );

  const handleActivateTab = useCallback(
    (path: string) => {
      if (!session) {
        return;
      }

      session.activate(path);
      resetEditorChrome();
    },
    [resetEditorChrome, session],
  );

  // Closing a tab with unsaved changes asks Save / Discard / Cancel first,
  // so a draft never outlives its tab.
  const [pendingCloseTab, setPendingCloseTab] = useState<string | null>(null);

  const handleCloseTab = useCallback(
    (path: string) => {
      if (!session) {
        return;
      }

      if (session.close(path) === "confirm") {
        setPendingCloseTab(path);
        return;
      }
      resetEditorChrome();
    },
    [resetEditorChrome, session],
  );

  const handleReorderTabs = useCallback(
    (fromIndex: number, toIndex: number) => {
      session?.reorder(fromIndex, toIndex);
    },
    [session],
  );

  const handleSelectedFileMissing = useCallback(
    (path: string) => {
      session?.forgetMissing(path);
    },
    [session],
  );

  const fileTabItems = useMemo<StandardTabItem[]>(
    () =>
      snapshot.tabs.map((tab) => ({
        id: tab.path,
        label: tab.path.split("/").pop() ?? tab.path,
        labelClassName: tab.pinned ? undefined : "italic",
        leading: isBufferDirty(snapshot.buffers[tab.path]) ? (
          <span
            className="size-2 shrink-0 rounded-full bg-amber-500"
            title={panelsT("unsavedChanges")}
          />
        ) : (
          <FileIcon className="shrink-0 text-muted-foreground" size={12} />
        ),
      })),
    [panelsT, snapshot.buffers, snapshot.tabs],
  );

  const handleReloadFromDisk = useCallback(() => {
    if (session && selectedFilePath) {
      session.reload(selectedFilePath);
    }
  }, [selectedFilePath, session]);

  const handleSaveEditing = useCallback(async () => {
    if (session && selectedFilePath) {
      await session.save(selectedFilePath);
    }
  }, [selectedFilePath, session]);

  const handleSaveAndClosePendingTab = useCallback(async () => {
    const pending = pendingCloseTab;
    setPendingCloseTab(null);
    if (session && pending && (await session.saveAndClose(pending))) {
      resetEditorChrome();
    }
  }, [pendingCloseTab, resetEditorChrome, session]);

  const handleDiscardAndClosePendingTab = useCallback(() => {
    const pending = pendingCloseTab;
    setPendingCloseTab(null);
    if (session && pending) {
      session.discardAndClose(pending);
      resetEditorChrome();
    }
  }, [pendingCloseTab, resetEditorChrome, session]);

  const isSaveShortcut = useShortcutMatcher("saveFile");
  const handleEditorKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isSaveShortcut(event.nativeEvent)) {
        event.preventDefault();
        void handleSaveEditing();
      }
    },
    [handleSaveEditing, isSaveShortcut],
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

  const treeModeToggle = (
    <Tabs
      onValueChange={(value) => {
        if (value === "files" || value === "search") {
          handleTreeModeChange(value);
        }
      }}
      value={treeMode}
    >
      <TabsList aria-label={fileSearchT("view")}>
        <TabsTrigger
          aria-label={commonT("files")}
          className="w-7 px-0"
          title={commonT("files")}
          value="files"
        >
          <Files className="size-3.5" />
        </TabsTrigger>
        <TabsTrigger
          aria-label={fileSearchT("title")}
          className="w-7 px-0"
          title={fileSearchT("title")}
          value="search"
        >
          <TextSearch className="size-3.5" />
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  if (!activeProject) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <div className="flex min-h-[50px] items-center gap-2 border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-3 py-2 text-sm font-medium">
          <RightPanelHeaderIconButton icon={Files} onClose={onClosePanel} />
          <span>{commonT("files")}</span>
          <div className="flex-1" />
          {onToggleExpanded ? (
            <RightPanelExpandButton
              expanded={Boolean(expanded)}
              onToggle={onToggleExpanded}
            />
          ) : null}
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
        <div className="flex shrink-0 items-center gap-1">
          <WordWrapToggle
            onPressedChange={handleWordWrapChange}
            pressed={wordWrapEnabled}
          />
          {onToggleExpanded ? (
            <RightPanelExpandButton
              expanded={Boolean(expanded)}
              onToggle={onToggleExpanded}
            />
          ) : null}
        </div>
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
          <div className="flex h-full flex-col border-r border-surface-200 dark:border-surface-800 bg-background">
            {/* One switch for both modes, so its selection slides between
                them; the visible mode renders its input beside it. */}
            <div className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
              {treeModeToggle}
              <div className="min-w-0 flex-1" ref={setTreeToolbarSlot} />
            </div>
            {/* Both stay mounted so switching keeps the tree's expansion
                and the search's results. */}
            <div
              className={cn("min-h-0 flex-1", treeMode !== "files" && "hidden")}
            >
              <ProjectFileTree
                active={active}
                onPinFile={handlePinFile}
                onSelectedFileMissing={handleSelectedFileMissing}
                onSelectFile={handleSelectFile}
                projectPath={activeProject.path}
                refreshVersion={projectFilesRefreshKey}
                selectedFilePath={selectedFilePath}
                toolbarSlot={treeMode === "files" ? treeToolbarSlot : null}
              />
            </div>
            <div
              className={cn(
                "min-h-0 flex-1",
                treeMode !== "search" && "hidden",
              )}
            >
              <ProjectSearchView
                focusRequest={projectSearchFocusRequest}
                toolbarSlot={treeMode === "search" ? treeToolbarSlot : null}
                onOpenResult={handleOpenSearchResult}
                projectPath={activeProject.path}
                refreshVersion={projectFilesRefreshKey}
              />
            </div>
          </div>
        </div>

        <PanelResizeHandle
          side="right"
          onResize={handleTreeResize}
          onResizeStart={handleTreeResizeStart}
        />

        {/* File content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {fileTabItems.length > 0 ? (
            <div className="flex shrink-0 items-center border-b border-surface-200 dark:border-surface-800 bg-surface-50 dark:bg-surface-900 px-2 py-1">
              <StandardTabs
                activeId={selectedFilePath}
                ariaLabel={panelsT("openFiles")}
                canClose={true}
                className="flex-1"
                items={fileTabItems}
                onActivate={handleActivateTab}
                onClose={handleCloseTab}
                onDoubleClick={(item) => handlePinFile(item.id)}
                onReorder={handleReorderTabs}
              />
              {selectedFilePath &&
              selectedFileBuffer &&
              !selectedFileIsImage ? (
                <div className="ml-2 flex shrink-0 items-center gap-1">
                  <Button
                    aria-label={uiT("searchCurrentFile")}
                    aria-pressed={isEditorSearchOpen}
                    className={
                      isEditorSearchOpen
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground"
                    }
                    onClick={() =>
                      setEditorSearchRequest((current) => current + 1)
                    }
                    size="icon-xs"
                    title={uiT("searchCurrentFile")}
                    type="button"
                    variant="ghost"
                  >
                    <Search className="size-3.5" />
                  </Button>
                  <CodeBlockCopyButton text={selectedFileBuffer.draftContent} />
                  <Button
                    aria-label={commonT("save")}
                    className={
                      selectedFileIsDirty ? undefined : "text-muted-foreground"
                    }
                    disabled={
                      selectedFileBuffer.status !== "dirty" ||
                      !selectedFileMetadata?.writable
                    }
                    onClick={() => void handleSaveEditing()}
                    size="icon-xs"
                    title={commonT("save")}
                    type="button"
                    variant={selectedFileIsDirty ? "accent-subtle" : "ghost"}
                  >
                    {selectedFileBuffer.status === "saving" ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <Save className="size-3.5" />
                    )}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            {!selectedFilePath ? (
              <div className="h-full p-3">
                <AppShellPlaceholder message={panelsT("noFileSelected")} />
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
              (selectedFileIsImage
                ? !selectedImagePreviewUrl
                : !selectedFileBuffer) ? (
              <div className="flex h-full items-center justify-center gap-2 text-muted-foreground text-sm">
                <Spinner className="size-4" />
              </div>
            ) : selectedFileIsImage ? (
              selectedImagePreviewUrl ? (
                <div className="flex h-full items-center justify-center p-6">
                  <img
                    alt={selectedFilePath}
                    className="max-h-full max-w-full object-contain"
                    src={selectedImagePreviewUrl}
                  />
                </div>
              ) : null
            ) : selectedFileBuffer ? (
              <CodeBlockContainer
                className="flex h-full max-h-full flex-col overflow-hidden rounded-none border-0 shadow-none"
                language={inferLanguage(selectedFilePath)}
                onKeyDownCapture={handleEditorKeyDown}
                style={{ contentVisibility: "visible" }}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  {selectedFileMetadata?.readOnlyReason ? (
                    <div className="shrink-0 border-amber-500/30 border-b bg-amber-500/10 px-3 py-2 text-amber-800 text-xs dark:text-amber-200">
                      {selectedFileMetadata.readOnlyReason}
                    </div>
                  ) : null}
                  {selectedFileBuffer.error ? (
                    <div className="flex shrink-0 items-center justify-between gap-3 border-destructive-border border-b bg-destructive-surface-muted px-3 py-2 text-destructive text-xs">
                      <div>
                        <div>
                          {describeError(
                            selectedFileBuffer.error,
                            panelsT("failedToSaveFile"),
                          )}
                        </div>
                        {selectedFileBuffer.status === "conflict" ? (
                          <div className="mt-1 font-medium">
                            {panelsT("reloadDraftWarning")}
                          </div>
                        ) : null}
                      </div>
                      {selectedFileBuffer.status === "conflict" ? (
                        <Button
                          className="shrink-0"
                          onClick={handleReloadFromDisk}
                          size="xs"
                          type="button"
                          variant="outline"
                        >
                          {panelsT("reloadFromDisk")}
                        </Button>
                      ) : null}
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
                        disabled={
                          selectedFileBuffer.status === "saving" ||
                          !selectedFileMetadata?.writable
                        }
                        filePath={selectedFilePath}
                        key={selectedFilePath}
                        lineEnding={
                          selectedFileMetadata?.lineEnding ??
                          (selectedFileBuffer.diskContent.includes("\r\n")
                            ? "crlf"
                            : "lf")
                        }
                        onChange={(content) =>
                          session?.edit(selectedFilePath, content)
                        }
                        onSearchOpenChange={setIsEditorSearchOpen}
                        reveal={selectedFileReveal}
                        searchRequest={editorSearchRequest}
                        value={selectedFileBuffer.draftContent}
                        wordWrap={wordWrapEnabled}
                      />
                    </Suspense>
                  </div>
                </div>
              </CodeBlockContainer>
            ) : null}
          </div>
        </div>
      </div>
      <AlertDialog
        open={pendingCloseTab !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingCloseTab(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {panelsT("saveChangesTitle", {
                name: pendingCloseTab?.split("/").pop() ?? "",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {panelsT("saveChangesDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{commonT("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              onClick={handleDiscardAndClosePendingTab}
            >
              {panelsT("dontSave")}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => void handleSaveAndClosePendingTab()}
            >
              {commonT("save")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export const FileExplorerPanel = memo(FileExplorerPanelImpl);
FileExplorerPanel.displayName = "FileExplorerPanel";
