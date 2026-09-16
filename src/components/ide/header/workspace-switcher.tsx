import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIdeStore } from "../ide-store";
import {
  DEFAULT_PROJECT_WORKSPACE_VIEW,
  getProjectWorkspaceDescriptor,
  isProjectWorkspaceView,
  PROJECT_WORKSPACE_DESCRIPTORS,
} from "../workspaces/registry";

export const WorkspaceSwitcher = () => {
  const t = useTranslations("workspace");
  const activeProjectId = useIdeStore((s) => s.activeProjectId);
  const workspaceView = useIdeStore(
    (s) =>
      s.projects.find((project) => project.id === s.activeProjectId)?.ui
        .workspaceView ?? DEFAULT_PROJECT_WORKSPACE_VIEW,
  );
  const setProjectWorkspaceView = useIdeStore((s) => s.setProjectWorkspaceView);
  const CurrentIcon = getProjectWorkspaceDescriptor(workspaceView).icon;
  const label = t("switchWorkspace");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={label}
            className="size-8 text-muted-foreground hover:text-foreground data-[state=open]:text-foreground [-webkit-app-region:no-drag]"
            disabled={!activeProjectId}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            size="icon"
            title={label}
            type="button"
            variant="ghost"
          />
        }
      >
        <CurrentIcon className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44 [-webkit-app-region:no-drag]"
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (activeProjectId && isProjectWorkspaceView(value)) {
              setProjectWorkspaceView(activeProjectId, value);
            }
          }}
          value={workspaceView}
        >
          {PROJECT_WORKSPACE_DESCRIPTORS.map(({ icon: Icon, id, labelKey }) => (
            <DropdownMenuRadioItem closeOnClick={true} key={id} value={id}>
              <Icon className="size-4" />
              {t(labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
