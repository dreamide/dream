import { FolderTree, MessageSquare, Plus, Server } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status-dot";
import { apiClient } from "@/lib/api-client";
import { getDesktopApi } from "@/lib/electron";
import {
  createAccentSparklesPalette,
  DEFAULT_SPARKLES_PALETTE,
  type SparklesPaletteName,
} from "@/lib/sparkles-palettes";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { DetectedEditor, ProjectIconInfo } from "@/types/ide";
import { getProjectHostId } from "../../../../electron/shared/persisted-state-codec.js";
import {
  chatIdsWaitingOnUser,
  projectIdsWithRunningChats,
  selectChatActivity,
} from "../chat-activity";
import { useChatTurnOutcomes } from "../chat-turn-outcome";
import { useIdeStore } from "../ide-store";
import { useHostChoices } from "../ssh/use-host-choices";
import { CHATS_TAB_ID, useOpenChatsTab } from "../standalone-chats";
import {
  moveTabItem,
  type StandardTabItem,
  StandardTabs,
} from "../standard-tabs";
import { ProjectActionsMenu } from "./project-actions-menu";
import {
  ProjectEditDialog,
  type ProjectEditTarget,
} from "./project-edit-dialog";
import {
  areProjectIconsEqual,
  normalizeProjectIconResponse,
} from "./project-icon";
import { ProjectTabFrame } from "./project-tab-frame";
import { ProjectTabIcon } from "./project-tab-icon";
import { getAwaitingAnswerProjectIds } from "./project-tab-status";

const PROJECT_TABS_END_DRAG_SPACE = 48;

export type ProjectTabItem = StandardTabItem & {
  awaitingAnswer: boolean;
  completed: boolean;
  path: string;
  sparklesPalette: SparklesPaletteName | string[];
  streaming: boolean;
  worktreeBranch: string | null;
};

const useDetectedEditors = (isMacOs: boolean) => {
  const [detectedEditors, setDetectedEditors] = useState<DetectedEditor[]>([]);

  useEffect(() => {
    const api = getDesktopApi();
    if (!api) {
      return;
    }

    void api.detectEditors().then(setDetectedEditors);
  }, []);

  return useMemo<DetectedEditor[]>(() => {
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
};

const useProjectIconScanner = ({
  appReady,
  projectIconScanSignature,
  updateProject,
}: {
  appReady: boolean;
  projectIconScanSignature: string;
  updateProject: ReturnType<typeof useIdeStore.getState>["updateProject"];
}) => {
  const projectIconScanSignatureRef = useRef("");

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
    const scanTargets = useIdeStore
      .getState()
      .projects.filter(
        // A chat folder has no icon of its own to find.
        (project) => project.icon?.source !== "custom" && !project.standalone,
      )
      .map((project) => ({
        hostId: getProjectHostId(project),
        id: project.id,
        path: project.path,
      }));

    for (const project of scanTargets) {
      void apiClient
        .projectIcon(
          { projectPath: project.path },
          { hostId: project.hostId, signal: abortController.signal },
        )
        // Icon detection is best effort; the tab keeps its current icon.
        .catch(() => null)
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
            currentProject.icon?.source === "custom" ||
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
};

export const ProjectTabs = () => {
  const projectsT = useTranslations("projects");
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const openProjects = useIdeStore((s) => s.projects);
  const closedProjects = useIdeStore((s) => s.closedProjects);
  // Standalone projects share the Chats tab; every other open project is
  // a tab of its own.
  const projects = useMemo(
    () => openProjects.filter((project) => !project.standalone),
    [openProjects],
  );
  const openStandalone = useMemo(
    () => openProjects.find((project) => project.standalone) ?? null,
    [openProjects],
  );
  const standaloneProjectIds = useMemo(
    () =>
      new Set(
        [...openProjects, ...closedProjects]
          .filter((project) => project.standalone)
          .map((project) => project.id),
      ),
    [closedProjects, openProjects],
  );
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const chatsTabActive =
    openStandalone !== null && openStandalone.id === activeProjectId;
  const openChatsTab = useOpenChatsTab();
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const setProjects = useIdeStore((s) => s.setProjects);
  const closeProject = useIdeStore((s) => s.closeProject);
  const updateProject = useIdeStore((s) => s.updateProject);
  const chats = useIdeStore((s) => s.chats);
  const hosts = useIdeStore((s) => s.hosts);
  const sshHosts = useHostChoices();
  const hostLabels = useMemo(
    () => new Map(sshHosts.map((host) => [host.id, host.label])),
    [sshHosts],
  );
  /** The SSH target of a project on an SSH host; null for a local one. */
  const sshTargetOf = useCallback(
    (projectId: string) => {
      const hostId = projects.find(
        (project) => project.id === projectId,
      )?.hostId;
      return hostId
        ? (sshHosts.find((host) => host.id === hostId)?.target ?? null)
        : null;
    },
    [projects, sshHosts],
  );
  // Running and waiting, here or on the host, whether or not this window
  // follows the turn (chat-activity.ts).
  const activity = useIdeStore(useShallow(selectChatActivity));
  const unreadChatIds = useChatTurnOutcomes((s) => s.unread);
  const accentColor = useUiStore((s) => s.accentColor);
  const accentSparklesPalette = useMemo(
    () => createAccentSparklesPalette(accentColor),
    [accentColor],
  );
  const runningProjectIds = useMemo(
    () => projectIdsWithRunningChats(activity, chats),
    [activity, chats],
  );
  const completedProjectIds = useMemo(
    () =>
      new Set(
        chats
          .filter((chat) => chat.deletedAt === null && unreadChatIds[chat.id])
          .map((chat) => chat.projectId),
      ),
    [chats, unreadChatIds],
  );
  const awaitingAnswerProjectIds = useMemo(
    () =>
      getAwaitingAnswerProjectIds({
        chats,
        awaitingAnswerChatIds: chatIdsWaitingOnUser(activity),
        streamingProjectIds: runningProjectIds,
      }),
    [activity, chats, runningProjectIds],
  );
  const projectIconScanSignature = projects
    .map((project) => `${project.id}\x00${project.path}`)
    .join("\x01");
  const projectOpenInEditors = useDetectedEditors(isMacOs);

  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(
    null,
  );
  const [editTarget, setEditTarget] = useState<ProjectEditTarget | null>(null);
  const [editValue, setEditValue] = useState("");
  const desktopApi = getDesktopApi();

  useProjectIconScanner({
    appReady,
    projectIconScanSignature,
    updateProject,
  });

  const handleAddProject = useCallback(() => {
    setActiveProjectId(null);
  }, [setActiveProjectId]);

  const handleOpenProjectInEditor = useCallback(
    (
      project: {
        id: string;
        path: string;
      },
      editorId: string,
    ) => {
      if (!desktopApi) {
        return;
      }

      void desktopApi.openInEditor({
        hostId: projects.find((item) => item.id === project.id)?.hostId,
        editorId,
        projectPath: project.path,
        sshTarget: sshTargetOf(project.id) ?? undefined,
      });
    },
    [desktopApi, sshTargetOf, projects],
  );

  const closeEditDialog = useCallback(() => {
    setEditTarget(null);
    setEditValue("");
  }, []);

  const handleEditSubmit = useCallback(
    (icon: ProjectIconInfo | null) => {
      const nextName = editValue.trim();
      if (!editTarget || !nextName) {
        return;
      }

      updateProject(editTarget.id, (current) => ({
        ...current,
        name: nextName,
        icon,
      }));

      closeEditDialog();
    },
    [closeEditDialog, editTarget, editValue, updateProject],
  );

  const chatsTabItem = useMemo<ProjectTabItem>(() => {
    const anyStandalone = (ids: Set<string>) => {
      for (const id of standaloneProjectIds) if (ids.has(id)) return true;
      return false;
    };
    const awaitingAnswer = anyStandalone(awaitingAnswerProjectIds);
    const completed = !chatsTabActive && anyStandalone(completedProjectIds);
    const activeChatPalette =
      chats.find(
        (chat) =>
          chat.id === openStandalone?.ui.activeChatId &&
          chat.deletedAt === null,
      )?.sparklesPalette ?? DEFAULT_SPARKLES_PALETTE;
    return {
      awaitingAnswer,
      completed,
      id: CHATS_TAB_ID,
      label: projectsT("chats"),
      leading: (
        <span
          className="flex size-4 shrink-0 items-center justify-center self-center leading-none text-muted-foreground"
          key={awaitingAnswer ? "awaiting" : completed ? "completed" : "chats"}
        >
          {awaitingAnswer ? (
            <StatusDot
              aria-label={projectsT("projectAwaitingAnswer")}
              color="amber"
            />
          ) : completed ? (
            <StatusDot
              aria-label={projectsT("projectFinishedProcessing")}
              color="green"
            />
          ) : (
            <MessageSquare className="size-3.5" />
          )}
        </span>
      ),
      path: "",
      sparklesPalette:
        activeChatPalette === "accent"
          ? accentSparklesPalette
          : activeChatPalette,
      streaming: anyStandalone(runningProjectIds),
      worktreeBranch: null,
    };
  }, [
    accentSparklesPalette,
    awaitingAnswerProjectIds,
    chats,
    chatsTabActive,
    completedProjectIds,
    openStandalone,
    projectsT,
    runningProjectIds,
    standaloneProjectIds,
  ]);

  const projectTabItems = useMemo<ProjectTabItem[]>(
    () =>
      projects.map((project) => {
        const awaitingAnswer = awaitingAnswerProjectIds.has(project.id);
        const completed =
          project.id !== activeProjectId && completedProjectIds.has(project.id);
        const leading = awaitingAnswer ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center self-center leading-none"
            key={`${project.id}:awaiting-answer`}
          >
            <StatusDot
              aria-label={projectsT("projectAwaitingAnswer")}
              color="amber"
            />
          </span>
        ) : completed ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center self-center leading-none"
            key={`${project.id}:completed`}
          >
            <StatusDot
              aria-label={projectsT("projectFinishedProcessing")}
              color="green"
            />
          </span>
        ) : project.hostId ? (
          // On an SSH host: the server icon, dimmed unless connected.
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center self-center leading-none",
              hosts[project.hostId]?.state === "connected"
                ? "text-muted-foreground"
                : "text-amber-500",
            )}
            key={`${project.id}:host:${project.hostId}`}
          >
            <Server className="size-3.5" />
          </span>
        ) : project.worktree && project.icon?.source !== "custom" ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center self-center leading-none text-muted-foreground"
            key={`${project.id}:worktree:${project.worktree.branch}`}
          >
            <FolderTree className="size-3.5" />
          </span>
        ) : project.icon ? (
          <span
            className="relative flex size-4 shrink-0 items-center justify-center self-center leading-none"
            key={`${project.id}:${project.icon.path}:${project.icon.mtimeMs}`}
          >
            <ProjectTabIcon
              hostId={getProjectHostId(project)}
              icon={project.icon}
              projectName={project.name}
              projectPath={project.path}
            />
          </span>
        ) : null;

        const activeChatPalette =
          (
            chats.find(
              (chat) =>
                chat.id === project.ui.activeChatId &&
                chat.projectId === project.id &&
                chat.deletedAt === null,
            ) ??
            chats.find(
              (chat) =>
                chat.projectId === project.id && chat.deletedAt === null,
            )
          )?.sparklesPalette ?? DEFAULT_SPARKLES_PALETTE;

        return {
          awaitingAnswer,
          completed,
          id: project.id,
          // A project on an SSH host says which.
          label: project.hostId
            ? `${project.name} · ${hostLabels.get(project.hostId) ?? project.hostId}`
            : project.name,
          leading,
          path: project.path,
          sparklesPalette:
            activeChatPalette === "accent"
              ? accentSparklesPalette
              : activeChatPalette,
          streaming: runningProjectIds.has(project.id),
          worktreeBranch: project.worktree?.branch ?? null,
        };
      }),
    [
      activeProjectId,
      accentSparklesPalette,
      awaitingAnswerProjectIds,
      chats,
      completedProjectIds,
      projectsT,
      projects,
      runningProjectIds,
      hosts,
      hostLabels,
    ],
  );

  const tabItems = useMemo(
    () => [chatsTabItem, ...projectTabItems],
    [chatsTabItem, projectTabItems],
  );

  // The Chats tab stays first: a move to or from it is ignored, and the
  // open standalone project keeps its place after the project tabs.
  const handleProjectReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (fromIndex === 0 || toIndex === 0) return;
      setProjects([
        ...moveTabItem(projects, fromIndex - 1, toIndex - 1),
        ...(openStandalone ? [openStandalone] : []),
      ]);
    },
    [openStandalone, projects, setProjects],
  );

  const handleActivate = useCallback(
    (id: string) => {
      if (id === CHATS_TAB_ID) {
        void openChatsTab();
        return;
      }
      setActiveProjectId(id);
    },
    [openChatsTab, setActiveProjectId],
  );

  return (
    <>
      <div className="min-w-0 flex-1 [-webkit-app-region:drag]">
        {appReady ? (
          <StandardTabs
            activeId={chatsTabActive ? CHATS_TAB_ID : activeProjectId}
            after={
              projectTabItems.length > 0 ? (
                <Button
                  aria-label={projectsT("addProject")}
                  className="mb-px text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
                  onClick={handleAddProject}
                  size="icon-sm"
                  title={projectsT("addProject")}
                  variant="ghost"
                >
                  <Plus className="size-4 shrink-0" />
                </Button>
              ) : null
            }
            ariaLabel={projectsT("projects")}
            interactiveClassName="[-webkit-app-region:no-drag]"
            items={tabItems}
            onActivate={handleActivate}
            onDoubleClick={(project) => {
              if (project.id === CHATS_TAB_ID) return;
              setOpenProjectMenuId(null);
              setEditTarget({ id: project.id, name: project.label });
              setEditValue(project.label);
            }}
            onReorder={handleProjectReorder}
            renderActions={(project) =>
              project.id === CHATS_TAB_ID ? null : (
                <ProjectActionsMenu
                  closeProject={closeProject}
                  editors={
                    sshTargetOf(project.id)
                      ? projectOpenInEditors.filter(
                          (editor) => editor.supportsRemote,
                        )
                      : projectOpenInEditors
                  }
                  isMacOs={isMacOs}
                  onOpenInEditor={handleOpenProjectInEditor}
                  open={openProjectMenuId === project.id}
                  project={project}
                  setOpen={(open) =>
                    setOpenProjectMenuId(open ? project.id : null)
                  }
                  setEditTarget={setEditTarget}
                  setEditValue={setEditValue}
                />
              )
            }
            renderFrame={(project, tab) => (
              <ProjectTabFrame
                sparklesPalette={project.sparklesPalette}
                streaming={project.streaming && !project.awaitingAnswer}
              >
                {tab}
              </ProjectTabFrame>
            )}
            reservedEndWidth={
              projectTabItems.length > 0 ? PROJECT_TABS_END_DRAG_SPACE : 0
            }
          />
        ) : null}
      </div>

      <ProjectEditDialog
        key={editTarget?.id ?? "closed"}
        project={
          projects.find((project) => project.id === editTarget?.id) ?? null
        }
        onClose={closeEditDialog}
        onSubmit={handleEditSubmit}
        onValueChange={setEditValue}
        target={editTarget}
        value={editValue}
      />
    </>
  );
};
