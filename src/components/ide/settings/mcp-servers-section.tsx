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
import { McpImportPanel } from "./mcp-import-panel";
import { McpServerForm, type McpServerFormTarget } from "./mcp-server-form";

export type McpView =
  | { kind: "list" }
  | { kind: "form"; target: McpServerFormTarget }
  | { kind: "import" };

export const MCP_LIST_VIEW: McpView = { kind: "list" };
const LIST_VIEW = MCP_LIST_VIEW;

export const McpServersSection = ({
  setView,
  view,
}: {
  setView: (view: McpView) => void;
  view: McpView;
}) => {
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
    setView(LIST_VIEW);
  };

  const handleImport = (inputs: McpServerInput[]) => {
    updateServers((current) => {
      const names = new Set(current.map((server) => server.name));
      const added = inputs
        .filter((input) => !names.has(input.name))
        .map((input) => createMcpServer(input));
      return [...current, ...added];
    });
    setView(LIST_VIEW);
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

  if (view.kind === "form") {
    return (
      <div className="rounded-lg p-3">
        <McpServerForm
          existingNames={existingNames}
          key={view.target === "new" ? "new" : view.target.id}
          onCancel={() => setView(LIST_VIEW)}
          onSubmit={(input) => handleSubmit(view.target, input)}
          target={view.target}
        />
      </div>
    );
  }

  if (view.kind === "import") {
    return (
      <div className="rounded-lg p-3">
        <McpImportPanel
          existingNames={existingNames}
          onCancel={() => setView(LIST_VIEW)}
          onImport={handleImport}
          projectPath={activeProjectPath}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-lg p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{settingsT("mcpServers")}</h3>
          <p className="text-muted-foreground text-sm">
            {settingsT("mcpServersDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setView({ kind: "import" })}
            size="sm"
            type="button"
            variant="outline"
          >
            <Download className="size-4" />
            {settingsT("mcpImport")}
          </Button>
          <Button
            onClick={() => setView({ kind: "form", target: "new" })}
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
        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">
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
                        onClick={() =>
                          setView({ kind: "form", target: server })
                        }
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        aria-label={commonT("delete")}
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
    </div>
  );
};
