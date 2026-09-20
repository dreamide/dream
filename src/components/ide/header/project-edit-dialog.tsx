import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  isMcpServerEnabledForProject,
  MCP_PROVIDER_SUPPORT,
} from "@/lib/mcp-servers";
import type { McpServerConfig, ProjectConfig } from "@/types/ide";

export type ProjectEditTarget = {
  id: string;
  name: string;
};

export const ProjectEditDialog = ({
  mcpServers,
  projectConfig,
  onOpenMcpSettings,
  onClose,
  onSubmit,
  onValueChange,
  target,
  value,
}: {
  mcpServers: McpServerConfig[];
  projectConfig: ProjectConfig | null;
  onOpenMcpSettings: () => void;
  onClose: () => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    mcpServerOverrides: Record<string, boolean>,
  ) => void;
  onValueChange: (value: string) => void;
  target: ProjectEditTarget | null;
  value: string;
}) => {
  const commonT = useTranslations("common");
  const projectsT = useTranslations("projects");
  const settingsT = useTranslations("settings");
  const [mcpServerOverrides, setMcpServerOverrides] = useState<
    Record<string, boolean>
  >({});
  const mcpSupported = projectConfig
    ? MCP_PROVIDER_SUPPORT[projectConfig.provider]
    : true;

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={target !== null}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl sm:p-8">
        <form
          className="space-y-6"
          onSubmit={(event) => onSubmit(event, mcpServerOverrides)}
        >
          <DialogHeader>
            <DialogTitle className="text-base leading-6">
              {projectsT("editProject")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="edit-project-name">{commonT("name")}</Label>
            <Input
              autoFocus
              id="edit-project-name"
              onChange={(event) => onValueChange(event.target.value)}
              placeholder={commonT("enterName")}
              value={value}
            />
          </div>
          <section
            aria-labelledby="project-mcp-heading"
            className="min-w-0 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium" id="project-mcp-heading">
                {projectsT("mcpServersMenu")}
              </h3>
              <Button
                onClick={onOpenMcpSettings}
                size="sm"
                type="button"
                variant="outline"
              >
                {projectsT("mcpManageServers")}
              </Button>
            </div>
            {mcpSupported ? (
              mcpServers.length > 0 ? (
                <div className="overflow-hidden rounded-md border">
                  <table
                    aria-labelledby="project-mcp-heading"
                    className="w-full table-fixed text-sm"
                  >
                    <tbody className="divide-y">
                      {mcpServers.map((server) => (
                        <tr key={server.id}>
                          <td className="px-3 py-3">
                            <Label
                              className="min-w-0 break-all"
                              htmlFor={`project-mcp-${server.id}`}
                            >
                              {server.name}
                            </Label>
                          </td>
                          <td className="w-16 px-3 py-3 text-right">
                            <Switch
                              id={`project-mcp-${server.id}`}
                              checked={
                                mcpServerOverrides[server.id] ??
                                isMcpServerEnabledForProject(
                                  server,
                                  projectConfig,
                                )
                              }
                              onCheckedChange={(checked) =>
                                setMcpServerOverrides((current) => ({
                                  ...current,
                                  [server.id]: checked,
                                }))
                              }
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {settingsT("mcpNoServers")}
                </p>
              )
            ) : (
              <p className="text-sm text-muted-foreground">
                {settingsT("mcpCursorUnsupported")}
              </p>
            )}
          </section>
          <DialogFooter>
            <Button onClick={onClose} type="button" variant="outline">
              {commonT("cancel")}
            </Button>
            <Button disabled={value.trim().length === 0} type="submit">
              {commonT("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
