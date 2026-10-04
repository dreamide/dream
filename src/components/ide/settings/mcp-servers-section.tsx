import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createMcpServer, type McpServerInput } from "@/lib/mcp-servers";
import type { McpServerConfig } from "@/types/ide";
import { useIdeStore } from "../ide-store";
import { McpImportDialog } from "./mcp-import-panel";
import { McpServerDialog, type McpServerFormTarget } from "./mcp-server-form";

type McpDialog =
  | { kind: "form"; target: McpServerFormTarget }
  | { kind: "import" };

export const McpServersSection = () => {
  const settingsT = useTranslations("settings");
  const commonT = useTranslations("common");
  const servers = useIdeStore((s) => s.settings.mcpServers);
  const setSettings = useIdeStore((s) => s.setSettings);
  const activeProjectPath = useIdeStore(
    (s) =>
      s.projects.find((project) => project.id === s.activeProjectId)?.path ??
      null,
  );
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<McpDialog | null>(null);
  const closeDialog = () => setDialog(null);

  const existingNames = servers.map((server) => server.name);

  const updateServers = (
    updater: (servers: McpServerConfig[]) => McpServerConfig[],
  ) =>
    setSettings((previous) => ({
      ...previous,
      mcpServers: updater(previous.mcpServers),
    }));

  const handleSubmit = (target: McpServerFormTarget, input: McpServerInput) => {
    if (target !== "new") {
      updateServers((current) =>
        current.map((server) =>
          server.id === target.id ? { ...server, ...input } : server,
        ),
      );
    } else {
      updateServers((current) => [...current, createMcpServer(input)]);
    }
    closeDialog();
  };

  const handleImport = (inputs: McpServerInput[]) => {
    updateServers((current) => {
      const names = new Set(current.map((server) => server.name));
      const added = inputs
        .filter((input) => !names.has(input.name))
        .map((input) => createMcpServer(input));
      return [...current, ...added];
    });
    closeDialog();
  };

  const handleDelete = (server: McpServerConfig) => {
    if (pendingDeleteId !== server.id) {
      setPendingDeleteId(server.id);
      return;
    }
    updateServers((current) =>
      current.filter((candidate) => candidate.id !== server.id),
    );
    setPendingDeleteId(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-base">{settingsT("mcpServers")}</h3>
          <p className="text-muted-foreground text-sm">
            {settingsT("mcpServersDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setDialog({ kind: "import" })}
            size="sm"
            type="button"
            variant="outline"
          >
            <Download className="size-4" />
            {settingsT("mcpImport")}
          </Button>
          <Button
            onClick={() => setDialog({ kind: "form", target: "new" })}
            size="sm"
            type="button"
          >
            <Plus className="size-4" />
            {settingsT("mcpAddServer")}
          </Button>
        </div>
      </div>

      {servers.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-md border border-dashed">
          <p className="text-muted-foreground text-sm">
            {settingsT("mcpNoServers")}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-white dark:bg-surface-950">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent dark:hover:bg-transparent">
                <TableHead className="w-24">
                  {settingsT("mcpEnabled")}
                </TableHead>
                <TableHead>{settingsT("mcpName")}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {servers.map((server) => (
                <TableRow key={server.id}>
                  <TableCell>
                    <Switch
                      aria-label={settingsT("mcpEnabled")}
                      checked={server.enabled}
                      onCheckedChange={(checked) =>
                        updateServers((current) =>
                          current.map((candidate) =>
                            candidate.id === server.id
                              ? { ...candidate, enabled: checked }
                              : candidate,
                          ),
                        )
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium font-mono text-sm">
                        {server.name}
                      </span>
                      <Badge variant="outline">{server.transport}</Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        aria-label={commonT("edit")}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() =>
                          setDialog({ kind: "form", target: server })
                        }
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        aria-label={commonT("delete")}
                        className={
                          pendingDeleteId === server.id
                            ? undefined
                            : "text-muted-foreground hover:text-foreground"
                        }
                        onBlur={() =>
                          setPendingDeleteId((current) =>
                            current === server.id ? null : current,
                          )
                        }
                        onClick={() => handleDelete(server)}
                        size={pendingDeleteId === server.id ? "sm" : "icon-sm"}
                        type="button"
                        variant={
                          pendingDeleteId === server.id
                            ? "destructive"
                            : "ghost"
                        }
                      >
                        {pendingDeleteId === server.id ? (
                          settingsT("mcpDeleteConfirm")
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {dialog?.kind === "form" ? (
        <McpServerDialog
          existingNames={existingNames}
          key={dialog.target === "new" ? "new" : dialog.target.id}
          onCancel={closeDialog}
          onSubmit={(input) => handleSubmit(dialog.target, input)}
          target={dialog.target}
        />
      ) : null}
      {dialog?.kind === "import" ? (
        <McpImportDialog
          existingNames={existingNames}
          onCancel={closeDialog}
          onImport={handleImport}
          projectPath={activeProjectPath}
        />
      ) : null}
    </div>
  );
};
