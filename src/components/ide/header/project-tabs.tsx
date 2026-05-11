import { Plus } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import type { DetectedEditor } from "@/types/ide";
import { useIdeStore } from "../ide-store";
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
import { ProjectTabFrame } from "./project-tab-frame";
import {
  areProjectIconsEqual,
  normalizeProjectIconResponse,
  ProjectTabIcon,
} from "./project-tab-icon";

export type ProjectTabItem = StandardTabItem & {
  completed: boolean;
  path: string;
  streaming: boolean;
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
};

const useProjectCompletionStatus = ({
  activeProjectId,
  streamingProjectIds,
}: {
  activeProjectId: string | null;
  streamingProjectIds: Set<string>;
}) => {
  const [completedProjectIds, setCompletedProjectIds] = useState<
    Record<string, boolean>
  >({});
  const previousStreamingProjectIdsRef = useRef<Set<string>>(new Set());

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

  return completedProjectIds;
};

export const ProjectTabs = () => {
  const appReady = useIdeStore((s) => s.appReady);
  const isMacOs = useIdeStore((s) => s.isMacOs);
  const projects = useIdeStore((s) => s.projects);
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const setActiveProjectId = useIdeStore((s) => s.setActiveProjectId);
  const setProjects = useIdeStore((s) => s.setProjects);
  const closeProject = useIdeStore((s) => s.closeProject);
  const updateProject = useIdeStore((s) => s.updateProject);
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
  const completedProjectIds = useProjectCompletionStatus({
    activeProjectId,
    streamingProjectIds,
  });
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
        path: string;
      },
      editorId: string,
    ) => {
      if (!desktopApi) {
        return;
      }

      void desktopApi.openInEditor({
        editorId,
        projectPath: project.path,
      });
    },
    [desktopApi],
  );

  const closeEditDialog = useCallback(() => {
    setEditTarget(null);
    setEditValue("");
  }, []);

  const handleEditSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextName = editValue.trim();
      if (!editTarget || !nextName) {
        return;
      }

      updateProject(editTarget.id, (current) => ({
        ...current,
        name: nextName,
      }));

      closeEditDialog();
    },
    [closeEditDialog, editTarget, editValue, updateProject],
  );

  const projectTabItems = useMemo<ProjectTabItem[]>(
    () =>
      projects.map((project) => {
        const completed =
          Boolean(completedProjectIds[project.id]) &&
          project.id !== activeProjectId;
        const leading = completed ? (
          <span
            className="flex size-4 shrink-0 items-center justify-center self-center leading-none"
            key={`${project.id}:completed`}
          >
            <span
              aria-hidden="true"
              className="size-2 shrink-0 rounded-full bg-success-surface0 animate-status-dot-pulse"
            />
          </span>
        ) : project.icon ? (
          <span
            className="relative flex size-4 shrink-0 items-center justify-center self-center leading-none"
            key={`${project.id}:${project.icon.path}:${project.icon.mtimeMs}`}
          >
            <ProjectTabIcon
              icon={project.icon}
              projectName={project.name}
              projectPath={project.path}
            />
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
    <>
      <div className="min-w-0 flex-1 [-webkit-app-region:drag]">
        {appReady ? (
          <StandardTabs
            activeId={activeProjectId}
            after={
              projectTabItems.length > 0 ? (
                <Button
                  aria-label="Add project"
                  className="mb-px text-muted-foreground hover:text-foreground [-webkit-app-region:no-drag]"
                  onClick={handleAddProject}
                  size="icon-sm"
                  title="Add project"
                  variant="ghost"
                >
                  <Plus className="size-4 shrink-0" />
                </Button>
              ) : null
            }
            ariaLabel="Projects"
            interactiveClassName="[-webkit-app-region:no-drag]"
            items={projectTabItems}
            onActivate={setActiveProjectId}
            onReorder={handleProjectReorder}
            renderActions={(project) => (
              <ProjectActionsMenu
                closeProject={closeProject}
                editors={projectOpenInEditors}
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
            )}
            renderFrame={(project, tab) => (
              <ProjectTabFrame streaming={project.streaming}>
                {tab}
              </ProjectTabFrame>
            )}
          />
        ) : null}
      </div>

      <ProjectEditDialog
        onClose={closeEditDialog}
        onSubmit={handleEditSubmit}
        onValueChange={setEditValue}
        target={editTarget}
        value={editValue}
      />
    </>
  );
};
