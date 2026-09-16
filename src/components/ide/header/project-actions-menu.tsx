import {
  Ellipsis,
  ExternalLink,
  FilePenLine,
  Server,
  Settings2,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  isMcpServerEnabledForProject,
  MCP_PROVIDER_SUPPORT,
} from "@/lib/mcp-servers";
import { cn } from "@/lib/utils";
import type {
  DetectedEditor,
  McpServerConfig,
  ProjectConfig,
} from "@/types/ide";
import { OpenInEditorIcon } from "./open-in-editor-icon";
import type { ProjectEditTarget } from "./project-edit-dialog";
import type { ProjectTabItem } from "./project-tabs";

export const ProjectActionsMenu = ({
  closeProject,
  editors,
  isMacOs,
  mcpServers,
  onOpenInEditor,
  onOpenMcpSettings,
  onToggleMcpServer,
  open,
  project,
  projectConfig,
  setEditTarget,
  setEditValue,
  setOpen,
}: {
  closeProject: (projectId: string) => void;
  editors: DetectedEditor[];
  isMacOs: boolean;
  mcpServers: McpServerConfig[];
  onOpenInEditor: (
    project: {
      path: string;
    },
    editorId: string,
  ) => void;
  onOpenMcpSettings: () => void;
  onToggleMcpServer: (
    projectId: string,
    serverId: string,
    enabled: boolean,
  ) => void;
  open: boolean;
  project: ProjectTabItem;
  projectConfig: ProjectConfig | null;
  setEditTarget: (target: ProjectEditTarget) => void;
  setEditValue: (value: string) => void;
  setOpen: (open: boolean) => void;
}) => {
  const commonT = useTranslations("common");
  const projectsT = useTranslations("projects");
  const settingsT = useTranslations("settings");
  const mcpSupported = projectConfig
    ? MCP_PROVIDER_SUPPORT[projectConfig.provider]
    : true;

  return (
    <div
      className={cn(
        "absolute top-1/2 right-0.5 -translate-y-1/2 transition-opacity",
        open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
      )}
    >
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={projectsT("projectActions", { name: project.label })}
              className="h-8 w-8 bg-transparent p-0 hover:!bg-transparent data-[state=open]:!bg-transparent aria-expanded:!bg-transparent [-webkit-app-region:no-drag]"
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
          <Ellipsis className="size-4 opacity-50 transition-opacity group-hover/button:opacity-100" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-44 [-webkit-app-region:no-drag]"
        >
          <DropdownMenuItem
            onClick={() => {
              setEditTarget({
                id: project.id,
                name: project.label,
              });
              setEditValue(project.label);
            }}
          >
            <FilePenLine className="size-4" />
            {commonT("edit")}
          </DropdownMenuItem>
          {editors.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <ExternalLink className="size-4" />
                {commonT("openIn")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="[-webkit-app-region:no-drag]">
                {editors.map((editor) => (
                  <DropdownMenuItem
                    key={editor.id}
                    onClick={() => onOpenInEditor(project, editor.id)}
                  >
                    <OpenInEditorIcon editor={editor} isMacOs={isMacOs} />
                    {editor.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Server className="size-4" />
              {projectsT("mcpServersMenu")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="[-webkit-app-region:no-drag]">
              {!mcpSupported ? (
                <DropdownMenuItem disabled>
                  {settingsT("mcpCursorUnsupported")}
                </DropdownMenuItem>
              ) : null}
              {mcpSupported
                ? mcpServers.map((server) => (
                    <DropdownMenuCheckboxItem
                      checked={isMcpServerEnabledForProject(
                        server,
                        projectConfig,
                      )}
                      key={server.id}
                      onCheckedChange={(checked) =>
                        onToggleMcpServer(project.id, server.id, checked)
                      }
                    >
                      {server.name}
                    </DropdownMenuCheckboxItem>
                  ))
                : null}
              {mcpSupported && mcpServers.length > 0 ? (
                <DropdownMenuSeparator />
              ) : null}
              <DropdownMenuItem onClick={onOpenMcpSettings}>
                <Settings2 className="size-4" />
                {projectsT("mcpManageServers")}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => closeProject(project.id)}>
            <X className="size-4" />
            {commonT("close")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
