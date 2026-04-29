import {
  Ellipsis,
  ExternalLink,
  FilePenLine,
  History,
  MessageSquarePlus,
  Minus,
  PanelRight,
  Plus,
  Settings,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import cursorIcon from "material-icon-theme/icons/cursor.svg";
import sublimeIcon from "material-icon-theme/icons/sublime.svg";
import vimIcon from "material-icon-theme/icons/vim.svg";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import powershellIcon from "@/assets/powershell.svg";
import vscodeIcon from "@/assets/vscode.svg";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import Sparkles from "@/components/ui/sparkles";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import type { DetectedEditor, ProjectIconInfo } from "@/types/ide";
import { ToggleButton } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { ProjectSidebar } from "./projects-panel";
import {
  moveTabItem,
  type StandardTabItem,
  StandardTabs,
} from "./standard-tabs";

type RenameTarget = {
  id: string;
  name: string;
};

type ProjectTabItem = StandardTabItem & {
  completed: boolean;
  path: string;
  streaming: boolean;
};

const areProjectIconsEqual = (
  left: ProjectIconInfo | null,
  right: ProjectIconInfo | null,
) =>
  left?.path === right?.path &&
  left?.mimeType === right?.mimeType &&
  left?.source === right?.source &&
  left?.mtimeMs === right?.mtimeMs;

const getProjectIconUrl = (projectPath: string, iconPath: string) =>
  `/api/project-file-raw?projectPath=${encodeURIComponent(projectPath)}&filePath=${encodeURIComponent(iconPath)}`;

const normalizeProjectIconResponse = (
  value: unknown,
): ProjectIconInfo | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const icon = value as Partial<ProjectIconInfo>;
  const iconPath = typeof icon.path === "string" ? icon.path.trim() : "";
  if (!iconPath) {
    return null;
  }

  return {
    mimeType:
      typeof icon.mimeType === "string" && icon.mimeType.trim()
        ? icon.mimeType.trim()
        : "application/octet-stream",
    mtimeMs: typeof icon.mtimeMs === "number" ? icon.mtimeMs : 0,
    path: iconPath,
    source:
      typeof icon.source === "string" && icon.source.trim()
        ? icon.source.trim()
        : "unknown",
  };
};

const ProjectTabIcon = ({
  icon,
  projectName,
  projectPath,
}: {
  icon: ProjectIconInfo | null;
  projectName: string;
  projectPath: string;
}) => {
  const [failed, setFailed] = useState(false);

  if (!icon || failed) {
    return null;
  }

  return (
    <img
      alt=""
      aria-hidden="true"
      className="size-4 shrink-0 rounded-sm object-contain"
      draggable={false}
      onError={() => setFailed(true)}
      src={getProjectIconUrl(projectPath, icon.path)}
      title={projectName}
    />
  );
};

const CHAT_HISTORY_PANEL_WIDTH_PX = 520;
const CHAT_HISTORY_PANEL_MARGIN_PX = 8;
const CHAT_HISTORY_TRANSITION_MS = 200;

const getChatHistoryTopOffset = () =>
  (document.getElementById("app-titlebar")?.getBoundingClientRect().bottom ??
    0) + CHAT_HISTORY_PANEL_MARGIN_PX;

const ChatHistoryOverlay = ({
  onClose,
  open,
}: {
  onClose: () => void;
  open: boolean;
}) => {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [topOffset, setTopOffset] = useState(() =>
    typeof document === "undefined" ? 0 : getChatHistoryTopOffset(),
  );

  useEffect(() => {
    if (open) {
      setMounted(true);
      let secondFrame: number | null = null;
      const firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(firstFrame);
        if (secondFrame !== null) {
          cancelAnimationFrame(secondFrame);
        }
      };
    }

    setVisible(false);
    const timeout = window.setTimeout(
      () => setMounted(false),
      CHAT_HISTORY_TRANSITION_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [open]);

  useEffect(() => {
    if (!mounted || typeof window === "undefined") {
      return;
    }

    const syncTopOffset = () => {
      setTopOffset(getChatHistoryTopOffset());
    };

    syncTopOffset();
    window.addEventListener("resize", syncTopOffset);
    return () => window.removeEventListener("resize", syncTopOffset);
  }, [mounted]);

  if (!mounted || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      aria-hidden={!open}
      className={cn(
        "fixed inset-0 z-50 [-webkit-app-region:no-drag]",
        visible ? "pointer-events-auto" : "pointer-events-none",
      )}
      inert={!open}
    >
      <button
        aria-label="Close chat history"
        className="absolute inset-0 cursor-default bg-transparent"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <div
        className="absolute bottom-2 left-2 max-w-[calc(100vw-16px)] transition-[transform,opacity] duration-200 ease-out will-change-[transform,opacity]"
        style={{
          opacity: visible ? 1 : 0,
          top: topOffset,
          transform: visible
            ? "translateX(0)"
            : `translateX(calc(-100% - ${CHAT_HISTORY_PANEL_MARGIN_PX}px))`,
          width: CHAT_HISTORY_PANEL_WIDTH_PX,
        }}
      >
        <ProjectSidebar className="h-full" onChatSelect={onClose} />
      </div>
    </div>,
    document.body,
  );
};

const VscodeMark = ({ className }: { className?: string }) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    src={vscodeIcon}
  />
);

const EditorImageMark = ({
  className,
  src,
}: {
  className?: string;
  src: string;
}) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0 object-contain", className)}
    draggable={false}
    src={src}
  />
);

const FinderMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    fill="none"
    viewBox="0 0 32 32"
  >
    <rect fill="#63C7FF" height="26" rx="6" width="26" x="3" y="3" />
    <path d="M16 3h7a6 6 0 0 1 6 6v17H16z" fill="#2494FF" />
    <path d="M16 6v20" stroke="#0B5CAD" strokeLinecap="round" />
    <path d="M10.5 13.5v2" stroke="#073B78" strokeLinecap="round" />
    <path d="M21.5 13.5v2" stroke="#073B78" strokeLinecap="round" />
    <path
      d="M10.5 21.5c2.8 2 8.2 2 11 0"
      stroke="#073B78"
      strokeLinecap="round"
      strokeWidth="1.5"
    />
  </svg>
);

const WindowsExplorerMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    viewBox="0 0 32 32"
  >
    <path
      d="M3 10.5A4.5 4.5 0 0 1 7.5 6H13l2.3 3H24.5A4.5 4.5 0 0 1 29 13.5V24a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"
      fill="#F7C948"
    />
    <path d="M3 12h26v4H3z" fill="#E7A720" />
    <path
      d="M4 14h24.3l-2.2 10.8A4 4 0 0 1 22.2 28H6.9A4 4 0 0 1 3 23.2z"
      fill="#FFD865"
    />
    <path
      d="M5 15.5h22l-1.9 8.9A3 3 0 0 1 22.2 27H7a3 3 0 0 1-3-3.4z"
      fill="#F6B73C"
    />
    <path d="M8 17.5h16" stroke="#FFF2B3" strokeLinecap="round" />
  </svg>
);

const LinuxFilesMark = ({ className }: { className?: string }) => (
  <svg
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    viewBox="0 0 32 32"
  >
    <rect fill="#4F86F7" height="22" rx="5" width="26" x="3" y="7" />
    <path d="M3 12h26v12a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z" fill="#2F6FEA" />
    <path d="M7 5h8l2 4H7a3 3 0 0 1 0-4" fill="#7AA7FF" />
    <path d="M8 15h16" stroke="#CFE0FF" strokeLinecap="round" />
  </svg>
);

const JETBRAINS_MARKS: Record<
  string,
  { accent: string; label: string; primary: string; secondary: string }
> = {
  idea: {
    accent: "#FF3158",
    label: "IJ",
    primary: "#FF6B00",
    secondary: "#7B2FFF",
  },
  phpstorm: {
    accent: "#B15CFF",
    label: "PS",
    primary: "#6F42FF",
    secondary: "#FF4FD8",
  },
  pycharm: {
    accent: "#F8E71C",
    label: "PC",
    primary: "#23D18B",
    secondary: "#21A1FF",
  },
  webstorm: {
    accent: "#00E5FF",
    label: "WS",
    primary: "#00A3FF",
    secondary: "#005CFF",
  },
};

const JetBrainsMark = ({
  className,
  editorId,
}: {
  className?: string;
  editorId: string;
}) => {
  const mark = JETBRAINS_MARKS[editorId] ?? JETBRAINS_MARKS.idea;

  return (
    <svg
      aria-hidden="true"
      className={cn("size-4 shrink-0", className)}
      viewBox="0 0 32 32"
    >
      <rect fill={mark.primary} height="32" rx="7" width="32" />
      <path d="M0 32 32 0v32z" fill={mark.secondary} />
      <path d="M0 0h32L0 22z" fill={mark.accent} opacity="0.9" />
      <rect fill="#111111" height="18" rx="1.5" width="18" x="7" y="7" />
      <text
        fill="#ffffff"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fontSize="7"
        fontWeight="800"
        x="10"
        y="19"
      >
        {mark.label}
      </text>
    </svg>
  );
};

const PowerShellMark = ({ className }: { className?: string }) => (
  <img
    alt=""
    aria-hidden="true"
    className={cn("size-4 shrink-0", className)}
    src={powershellIcon}
  />
);

const OpenInEditorIcon = ({
  editor,
  isMacOs,
}: {
  editor: DetectedEditor;
  isMacOs: boolean;
}) => {
  if (editor.id === "vscode") {
    return <VscodeMark />;
  }

  if (editor.id === "cursor") {
    return <EditorImageMark src={cursorIcon} />;
  }

  if (editor.id in JETBRAINS_MARKS) {
    return <JetBrainsMark editorId={editor.id} />;
  }

  if (editor.id === "sublime") {
    return <EditorImageMark src={sublimeIcon} />;
  }

  if (editor.id === "vim" || editor.id === "neovim") {
    return <EditorImageMark src={vimIcon} />;
  }

  if (editor.isFileExplorer) {
    return isMacOs ? (
      <FinderMark />
    ) : editor.name === "File Explorer" ? (
      <WindowsExplorerMark />
    ) : (
      <LinuxFilesMark />
    );
  }

  if (editor.isTerminal) {
    return isMacOs ? (
      <TerminalSquare className="size-4 shrink-0" />
    ) : (
      <PowerShellMark />
    );
  }

  return <ExternalLink className="size-4 shrink-0" />;
};

export const IdeHeader = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const isElectron = useIdeStore((s) => s.isElectron);
  const panelVisibility = useIdeStore((s) => s.panelVisibility);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const togglePanel = useIdeStore((s) => s.togglePanel);
  const addChat = useIdeStore((s) => s.addChat);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const setProjects = useIdeStore((s) => s.setProjects);
  const closeProject = useIdeStore((s) => s.closeProject);
  const updateProject = useIdeStore((s) => s.updateProject);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);
  const openProjectTerminal = useIdeStore((s) => s.openProjectTerminal);
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );
  const projectTerminalPanelOpenByProject = useIdeStore(
    (s) => s.projectTerminalPanelOpenByProject,
  );
  const projectRightPanelOpenByProject = useIdeStore(
    (s) => s.projectRightPanelOpenByProject,
  );
  const chats = useIdeStore((s) => s.chats);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const streamingProjectIds = useMemo(
    () =>
      new Set(
        chats
          .filter((chat) => streamingChatIds[chat.id])
          .map((chat) => chat.projectId),
      ),
    [chats, streamingChatIds],
  );
  const projectIconScanSignature = projects
    .map((project) => `${project.id}\x00${project.path}`)
    .join("\x01");

  const activeProject =
    projects.find((project) => project.id === activeProjectId) ?? null;
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([]);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(
    null,
  );
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [completedProjectIds, setCompletedProjectIds] = useState<
    Record<string, boolean>
  >({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const projectOpenInEditors = useMemo<DetectedEditor[]>(() => {
    const fileExplorer = detectedEditors.find(
      (editor) => editor.id === "file-explorer",
    );
    const otherEditors = detectedEditors.filter(
      (editor) => editor.id !== "file-explorer",
    );

    return [
      fileExplorer ?? {
        executable: "",
        id: "file-explorer",
        isFileExplorer: true,
        isTerminal: false,
        name: isMacOs ? "Finder" : "File Explorer",
      },
      ...otherEditors,
    ];
  }, [detectedEditors, isMacOs]);
  const previousStreamingProjectIdsRef = useRef<Set<string>>(new Set());
  const projectIconScanSignatureRef = useRef("");
  const terminalOpen = activeProject
    ? (projectTerminalSessionIds[activeProject.id]?.length ?? 0) > 0
    : false;
  const activeProjectTerminalPanelOpen = activeProject
    ? (projectTerminalPanelOpenByProject[activeProject.id] ?? false)
    : false;
  const activeProjectRightPanelOpen = activeProject
    ? (projectRightPanelOpenByProject[activeProject.id] ??
      panelVisibility.right)
    : panelVisibility.right;
  const terminalHiddenWithActiveSession =
    terminalOpen && !activeProjectTerminalPanelOpen;
  const desktopApi = getDesktopApi();
  const handleOpenSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, [setSettingsOpen, setSettingsSection]);

  useEffect(() => {
    if (!historyOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setHistoryOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen]);

  const handleAddProject = useCallback(async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      window.alert("Open this app inside Electron to add project folders.");
      return;
    }

    const selectedPath = await desktopApi.pickProjectDirectory();
    if (!selectedPath) {
      return;
    }

    useIdeStore.getState().addProject(selectedPath);
  }, []);

  const handleOpenTerminal = useCallback(() => {
    if (!activeProject) {
      return;
    }

    void openProjectTerminal(activeProject.id);
  }, [activeProject, openProjectTerminal]);

  const handleOpenProjectInEditor = useCallback(
    async (
      project: {
        path: string;
      },
      editorId: string,
    ) => {
      if (!desktopApi) {
        return;
      }

      await desktopApi.openInEditor({
        editorId,
        projectPath: project.path,
      });
    },
    [desktopApi],
  );

  const handleAddChat = useCallback(() => {
    if (!activeProject) {
      return;
    }

    addChat(activeProject.id);
  }, [activeProject, addChat]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    void api.detectEditors().then(setDetectedEditors);
  }, []);

  useEffect(() => {
    if (
      !appReady ||
      !projectIconScanSignature ||
      projectIconScanSignatureRef.current === projectIconScanSignature
    ) {
      return;
    }

    projectIconScanSignatureRef.current = projectIconScanSignature;
    const abortController = new AbortController();
    const scanTargets = useIdeStore.getState().projects.map((project) => ({
      id: project.id,
      path: project.path,
    }));

    for (const project of scanTargets) {
      void fetch("/api/project-icon", {
        body: JSON.stringify({ projectPath: project.path }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: abortController.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            return null;
          }

          return (await response.json()) as { icon?: unknown };
        })
        .then((payload) => {
          if (!payload || abortController.signal.aborted) {
            return;
          }

          const nextIcon = normalizeProjectIconResponse(payload.icon);
          const currentProject = useIdeStore
            .getState()
            .projects.find((item) => item.id === project.id);

          if (
            !currentProject ||
            currentProject.path !== project.path ||
            areProjectIconsEqual(currentProject.icon, nextIcon)
          ) {
            return;
          }

          updateProject(project.id, (current) =>
            current.path === project.path
              ? {
                  ...current,
                  icon: nextIcon,
                }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            console.warn("Unable to detect project icon:", error);
          }
        });
    }

    return () => abortController.abort();
  }, [appReady, projectIconScanSignature, updateProject]);

  useEffect(() => {
    const previousStreamingProjectIds = previousStreamingProjectIdsRef.current;

    setCompletedProjectIds((current) => {
      let changed = false;
      const next = { ...current };

      for (const projectId of previousStreamingProjectIds) {
        if (
          !streamingProjectIds.has(projectId) &&
          projectId !== activeProjectId &&
          !next[projectId]
        ) {
          next[projectId] = true;
          changed = true;
        }
      }

      for (const projectId of streamingProjectIds) {
        if (next[projectId]) {
          delete next[projectId];
          changed = true;
        }
      }

      if (activeProjectId && next[activeProjectId]) {
        delete next[activeProjectId];
        changed = true;
      }

      return changed ? next : current;
    });

    previousStreamingProjectIdsRef.current = new Set(streamingProjectIds);
  }, [activeProjectId, streamingProjectIds]);

  const closeRenameDialog = useCallback(() => {
    setRenameTarget(null);
    setRenameValue("");
  }, []);

  const handleRenameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = renameValue.trim();
      if (!renameTarget || !nextName) {
        return;
      }

      updateProject(renameTarget.id, (current) => ({
        ...current,
        name: nextName,
      }));

      closeRenameDialog();
    },
    [closeRenameDialog, renameTarget, renameValue, updateProject],
  );

  const projectTabItems = useMemo<ProjectTabItem[]>(
    () =>
      projects.map((project) => {
        const completed =
          Boolean(completedProjectIds[project.id]) &&
          project.id !== activeProjectId;
        const leading =
          project.icon || completed ? (
            <span
              className="relative flex size-4 shrink-0 items-center justify-center"
              key={`${project.id}:${project.icon?.path ?? ""}:${project.icon?.mtimeMs ?? 0}:${completed}`}
            >
              <ProjectTabIcon
                icon={project.icon}
                projectName={project.name}
                projectPath={project.path}
              />
              {completed ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full bg-green-500",
                    project.icon &&
                      "absolute right-[-1px] bottom-[-1px] ring-2 ring-background",
                  )}
                />
              ) : null}
            </span>
          ) : null;

        return {
          completed,
          id: project.id,
          label: project.name,
          leading,
          path: project.path,
          streaming: streamingProjectIds.has(project.id),
        };
      }),
    [activeProjectId, completedProjectIds, projects, streamingProjectIds],
  );

  const handleProjectReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      setProjects(moveTabItem(projects, fromIndex, toIndex));
    },
    [projects, setProjects],
  );

  return (
    <header
      id="app-titlebar"
      className={cn(
        "flex shrink-0 flex-col border-b border-foreground/10 bg-muted/70 text-foreground backdrop-blur-sm [-webkit-app-region:drag]",
        isMacOs ? "pr-3" : "pr-0",
      )}
    >
      <div className="flex h-11 items-end gap-2 pl-3 [-webkit-app-region:drag]">
        <div
          className={cn(
            "h-8 shrink-0 [-webkit-app-region:drag]",
            isMacOs ? "w-24" : "w-0",
          )}
        />

        <div className="min-w-0 flex-1 pb-0.5 [-webkit-app-region:drag]">
          {appReady ? (
            <StandardTabs
              activeId={activeProjectId}
              after={
                <Button
                  aria-label="Add project"
                  className="mb-px h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
                  onClick={() => void handleAddProject()}
                  size="icon-sm"
                  title="Add project"
                  variant="ghost"
                >
                  <Plus className="size-4 shrink-0" />
                </Button>
              }
              ariaLabel="Projects"
              interactiveClassName="[-webkit-app-region:no-drag]"
              items={projectTabItems}
              onActivate={setActiveProjectId}
              onReorder={handleProjectReorder}
              renderActions={(project) => {
                const isProjectMenuOpen = openProjectMenuId === project.id;

                return (
                  <div
                    className={cn(
                      "absolute top-1/2 right-0.5 -translate-y-1/2 transition-opacity",
                      isProjectMenuOpen
                        ? "opacity-100"
                        : "opacity-0 group-hover:opacity-100",
                    )}
                  >
                    <DropdownMenu
                      onOpenChange={(open) =>
                        setOpenProjectMenuId(open ? project.id : null)
                      }
                      open={isProjectMenuOpen}
                    >
                      <DropdownMenuTrigger
                        render={
                          <Button
                            aria-label={`${project.label} actions`}
                            className="h-8 w-8 p-0 [-webkit-app-region:no-drag]"
                            onClick={(event) => {
                              event.stopPropagation();
                            }}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                            }}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          />
                        }
                      >
                        <Ellipsis className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="w-44 [-webkit-app-region:no-drag]"
                      >
                        <DropdownMenuItem
                          onClick={() => {
                            setRenameTarget({
                              id: project.id,
                              name: project.label,
                            });
                            setRenameValue(project.label);
                          }}
                        >
                          <FilePenLine className="size-4" />
                          Edit
                        </DropdownMenuItem>
                        {projectOpenInEditors.length > 0 ? (
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <ExternalLink className="size-4" />
                              Open in
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="[-webkit-app-region:no-drag]">
                              {projectOpenInEditors.map((editor) => (
                                <DropdownMenuItem
                                  key={editor.id}
                                  onClick={() =>
                                    void handleOpenProjectInEditor(
                                      project,
                                      editor.id,
                                    )
                                  }
                                >
                                  <OpenInEditorIcon
                                    editor={editor}
                                    isMacOs={isMacOs}
                                  />
                                  {editor.name}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => closeProject(project.id)}
                        >
                          <X className="size-4" />
                          Close
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              }}
              renderFrame={(project, tab) => (
                <Sparkles
                  className="w-full overflow-hidden"
                  density={38}
                  disabled={!project.streaming}
                  groundGlow={true}
                  height={10}
                  palette={["#9bf2ff", "#6ac7ff", "#caf8ff", "#5ea3ff"]}
                  position="bottom"
                  sizeMul={0.5}
                  speed={3}
                  style={{ position: "relative" }}
                  sway={0}
                >
                  {tab}
                </Sparkles>
              )}
            />
          ) : null}
        </div>

        {!isMacOs && isElectron && appReady ? <WindowControls /> : null}
      </div>

      {appReady ? (
        <div className="flex items-center gap-2 px-3 pb-1 [-webkit-app-region:drag]">
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <Button
              aria-label="Chat history"
              className={cn(
                "size-8 [-webkit-app-region:no-drag]",
                historyOpen
                  ? "text-foreground hover:text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setHistoryOpen((open) => !open)}
              size="icon"
              title="Chat history"
              variant="ghost"
            >
              <History className="size-4" />
            </Button>
            <Button
              aria-label="New chat"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
              disabled={!activeProject}
              onClick={handleAddChat}
              size="icon-sm"
              title="New chat"
              variant="ghost"
            >
              <MessageSquarePlus className="size-4 shrink-0" />
            </Button>
          </div>
          <div className="min-w-0 flex-1" />
          <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
            <Button
              aria-label="Open terminal"
              className={cn(
                "h-8 w-8 p-0 [-webkit-app-region:no-drag]",
                terminalHiddenWithActiveSession
                  ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
                  : terminalOpen
                    ? "text-foreground hover:text-foreground"
                    : "text-muted-foreground/50 hover:text-foreground",
              )}
              disabled={!activeProject}
              onClick={handleOpenTerminal}
              size="icon-sm"
              title="Open terminal"
              variant="ghost"
            >
              <TerminalSquare className="size-4 shrink-0" />
            </Button>
            <ToggleButton
              active={activeProjectRightPanelOpen}
              onClick={() => togglePanel("right")}
              title="Toggle right panel"
            >
              <PanelRight className="size-4" />
            </ToggleButton>
            <Button
              aria-label="Settings"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
              onClick={handleOpenSettings}
              size="icon-sm"
              title="Settings"
              variant="ghost"
            >
              <Settings className="size-4 shrink-0" />
            </Button>
          </div>
        </div>
      ) : null}

      {appReady ? (
        <ChatHistoryOverlay
          onClose={() => setHistoryOpen(false)}
          open={historyOpen}
        />
      ) : null}

      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            closeRenameDialog();
          }
        }}
        open={renameTarget !== null}
      >
        <DialogContent className="sm:max-w-sm">
          <form className="space-y-4" onSubmit={handleRenameSubmit}>
            <DialogHeader>
              <DialogTitle>Rename project</DialogTitle>
              <DialogDescription>
                Choose a new name for this project.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              onChange={(event) => setRenameValue(event.target.value)}
              placeholder="Enter a name"
              value={renameValue}
            />
            <DialogFooter>
              <Button
                onClick={closeRenameDialog}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={renameValue.trim().length === 0} type="submit">
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </header>
  );
};

const WindowControls = () => {
  const api = getDesktopApi();

  return (
    <div className="flex h-full items-stretch [-webkit-app-region:no-drag]">
      <button
        aria-label="Minimize"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => api?.windowMinimize()}
        type="button"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        aria-label="Maximize"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => api?.windowMaximize()}
        type="button"
      >
        <Square className="size-3" />
      </button>
      <button
        aria-label="Close"
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-500 hover:text-white"
        onClick={() => api?.windowClose()}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
};
