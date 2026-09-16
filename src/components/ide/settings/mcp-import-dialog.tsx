import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  describeMcpServerTarget,
  type McpServerInput,
} from "@/lib/mcp-servers";
import type { McpServerTransport } from "@/types/ide";

export type McpImportSourceKind =
  | "claudeUser"
  | "claudeProject"
  | "codexUser"
  | "cursorUser"
  | "cursorProject";

export type McpImportCandidate = {
  args: string[];
  command: string;
  env: Record<string, string>;
  headers: Record<string, string>;
  name: string;
  sources: { kind: McpImportSourceKind; path: string }[];
  transport: McpServerTransport;
  url: string;
  warnings: string[];
};

export const McpImportDialog = ({
  existingNames,
  onClose,
  onImport,
  open,
  projectPath,
}: {
  existingNames: string[];
  onClose: () => void;
  onImport: (servers: McpServerInput[]) => void;
  open: boolean;
  projectPath: string | null;
}) => {
  const commonT = useTranslations("common");
  const settingsT = useTranslations("settings");
  const [candidates, setCandidates] = useState<McpImportCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only used to seed the initial selection; changes must not refetch.
  const existingNamesRef = useRef(existingNames);
  existingNamesRef.current = existingNames;

  useEffect(() => {
    if (!open) {
      return;
    }
    const existingNames = existingNamesRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCandidates([]);
    setSelected(new Set());
    void fetch("/api/mcp-servers/import-candidates", {
      body: JSON.stringify({ projectPath: projectPath ?? undefined }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        const payload = (await response.json()) as {
          candidates: McpImportCandidate[];
        };
        if (cancelled) {
          return;
        }
        setCandidates(payload.candidates);
        setSelected(
          new Set(
            payload.candidates
              .filter((candidate) => !existingNames.includes(candidate.name))
              .map((candidate) => candidate.name),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setError(settingsT("mcpImportFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, settingsT]);

  const allSelected =
    candidates.length > 0 && selected.size === candidates.length;
  const selectedCandidates = useMemo(
    () => candidates.filter((candidate) => selected.has(candidate.name)),
    [candidates, selected],
  );

  const toggle = (name: string, checked: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });

  const handleImport = () => {
    onImport(
      selectedCandidates.map((candidate) => ({
        args: candidate.args,
        command: candidate.command,
        enabled: true,
        env: candidate.env,
        headers: candidate.headers,
        name: candidate.name,
        transport: candidate.transport,
        url: candidate.url,
      })),
    );
  };

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base leading-6">
            {settingsT("mcpImportTitle")}
          </DialogTitle>
          <DialogDescription>
            {settingsT("mcpImportDescription")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-40 items-center justify-center">
            <Spinner />
          </div>
        ) : error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : candidates.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {settingsT("mcpImportEmpty")}
          </p>
        ) : (
          <div className="min-w-0 space-y-2 overflow-hidden">
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor="mcp-import-select-all"
            >
              <Checkbox
                checked={allSelected}
                id="mcp-import-select-all"
                indeterminate={selected.size > 0 && !allSelected}
                onCheckedChange={(checked) =>
                  setSelected(
                    checked
                      ? new Set(candidates.map((candidate) => candidate.name))
                      : new Set(),
                  )
                }
              />
              {settingsT("mcpSelectAll")}
            </label>
            <div className="max-h-80 min-w-0 space-y-1 overflow-x-hidden overflow-y-auto rounded-md border p-1">
              {candidates.map((candidate) => {
                const exists = existingNames.includes(candidate.name);
                const checkboxId = `mcp-import-${candidate.name}`;
                return (
                  <label
                    className="flex cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-muted"
                    htmlFor={checkboxId}
                    key={candidate.name}
                  >
                    <Checkbox
                      checked={selected.has(candidate.name)}
                      className="mt-0.5"
                      id={checkboxId}
                      onCheckedChange={(checked) =>
                        toggle(candidate.name, checked)
                      }
                    />
                    <div className="min-w-0 flex-1 space-y-1 overflow-hidden">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium font-mono text-sm">
                          {candidate.name}
                        </span>
                        <Badge variant="outline">{candidate.transport}</Badge>
                        {exists ? (
                          <Badge variant="secondary">
                            {settingsT("mcpAlreadyExists")}
                          </Badge>
                        ) : null}
                      </div>
                      <p
                        className="truncate font-mono text-muted-foreground text-xs"
                        title={describeMcpServerTarget({
                          ...candidate,
                          createdAt: "",
                          enabled: true,
                          id: candidate.name,
                        })}
                      >
                        {describeMcpServerTarget({
                          ...candidate,
                          createdAt: "",
                          enabled: true,
                          id: candidate.name,
                        })}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {candidate.sources.map((source) => (
                          <Badge
                            key={`${source.kind}:${source.path}`}
                            title={source.path}
                            variant="ghost"
                          >
                            {settingsT(`mcpImportSource.${source.kind}`)}
                          </Badge>
                        ))}
                      </div>
                      {candidate.warnings.map((warning) => (
                        <p className="text-amber-600 text-xs" key={warning}>
                          {warning}
                        </p>
                      ))}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            {commonT("cancel")}
          </Button>
          <Button
            disabled={selectedCandidates.length === 0}
            onClick={handleImport}
            type="button"
          >
            {settingsT("mcpImportSelected", {
              count: selectedCandidates.length,
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
