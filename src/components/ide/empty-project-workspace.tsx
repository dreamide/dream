import {
  ArrowRight,
  Folder,
  FolderOpen,
  FolderTree,
  History,
  Plug,
  Settings,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import dreamSvg from "@/assets/dream.svg";
import { ProviderIcon } from "@/components/ai-elements/provider-icons";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getDesktopApi } from "@/lib/electron";
import { getConnectedProviders } from "@/lib/ide-defaults";
import { ProjectTabIcon } from "./header/project-tab-icon";
import { useIdeStore } from "./ide-store";
import { ALL_PROVIDERS, getProviderLabel } from "./ide-types";

export const EmptyProjectWorkspace = () => {
  const closedProjects = useIdeStore((s) => s.closedProjects);
  const settings = useIdeStore((s) => s.settings);
  const addProject = useIdeStore((s) => s.addProject);
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);

  const connectedProviders = useMemo(
    () => getConnectedProviders(settings),
    [settings],
  );
  const hasConnectedProvider = connectedProviders.length > 0;

  const recentProjects = useMemo(
    () => [...closedProjects].reverse().slice(0, 6),
    [closedProjects],
  );

  const handleOpenFolder = useCallback(async () => {
    const desktopApi = getDesktopApi();
    if (!desktopApi) {
      window.alert("Open this app inside Electron to add project folders.");
      return;
    }

    const selectedPath = await desktopApi.pickProjectDirectory();
    if (!selectedPath) {
      return;
    }

    addProject(selectedPath);
  }, [addProject]);

  const handleOpenProviders = useCallback(() => {
    setSettingsSection("providers");
    setSettingsOpen(true);
  }, [setSettingsOpen, setSettingsSection]);

  if (!hasConnectedProvider) {
    return (
      <Empty className="h-full gap-6 rounded-none border-0 p-6">
        <EmptyHeader className="max-w-xl gap-4">
          <img alt="" className="size-16" draggable={false} src={dreamSvg} />
          <EmptyMedia className="mb-0 size-10 rounded-full" variant="icon">
            <Plug className="size-5" />
          </EmptyMedia>
          <EmptyTitle>Connect a provider</EmptyTitle>
          <EmptyDescription className="max-w-md">
            Select at least one model before opening a project.
          </EmptyDescription>
        </EmptyHeader>

        <EmptyContent className="max-w-xl gap-6">
          <Button onClick={handleOpenProviders} size="lg">
            <Settings className="size-4" />
            Open Providers
          </Button>

          <div className="grid w-full gap-1">
            {ALL_PROVIDERS.map((provider) => (
              <button
                className="flex min-h-10 w-full min-w-0 items-center gap-3 rounded-sm border border-transparent px-3 py-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:border-surface-300 dark:hover:bg-[color-mix(in_oklab,var(--muted)_70%,var(--background))] dark:focus-visible:border-surface-700 focus-visible:outline-none"
                key={provider}
                onClick={handleOpenProviders}
                type="button"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
                  <ProviderIcon provider={provider} className="size-4" />
                </span>
                <span className="block min-w-0 flex-1 truncate font-medium text-foreground text-sm">
                  {getProviderLabel(provider)}
                </span>
                <ArrowRight className="size-4 shrink-0" />
              </button>
            ))}
          </div>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="h-full gap-6 rounded-none border-0 p-6">
      <EmptyHeader className="max-w-xl gap-4">
        <img alt="" className="size-16" draggable={false} src={dreamSvg} />
        <EmptyTitle>Get started</EmptyTitle>
      </EmptyHeader>

      <EmptyContent className="max-w-xl gap-10">
        <Button onClick={() => void handleOpenFolder()} size="lg">
          <FolderOpen className="size-4" />
          Open Folder
        </Button>

        {recentProjects.length > 0 ? (
          <div className="flex w-full flex-col items-stretch gap-2">
            <div className="flex items-center gap-2 px-1 font-medium text-muted-foreground text-sm">
              <History className="size-3.5" />
              Recently closed
            </div>
            <div className="grid w-full gap-1">
              {recentProjects.map((project) => {
                const isWorktree = project.worktree?.kind === "worktree";

                return (
                  <button
                    className="group flex min-h-12 w-full min-w-0 items-center gap-3 rounded-sm border border-transparent px-3 py-2 text-left text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:border-surface-300 dark:hover:bg-[color-mix(in_oklab,var(--muted)_70%,var(--background))] dark:focus-visible:border-surface-700 focus-visible:outline-none"
                    key={project.id}
                    onClick={() => addProject(project.path)}
                    type="button"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      {isWorktree ? (
                        <FolderTree className="size-4" />
                      ) : project.icon ? (
                        <ProjectTabIcon
                          fallback={<Folder className="size-4" />}
                          icon={project.icon}
                          projectName={project.name}
                          projectPath={project.path}
                        />
                      ) : (
                        <Folder className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-foreground text-sm">
                        {project.name}
                      </span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {isWorktree ? "worktree" : project.path}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </EmptyContent>
    </Empty>
  );
};
