import { AlertCircle, Logs, Play, RefreshCcw, Square, X } from "lucide-react";
import type { RefObject } from "react";
import { Group, Panel } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { AppShellPlaceholder, ResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { TERMINAL_MIN_HEIGHT_PX } from "./ide-types";

export interface PreviewPanelProps {
  onSyncPreviewBounds: () => void;
  previewHostRef: RefObject<HTMLDivElement | null>;
}

export const PreviewPanel = ({
  onSyncPreviewBounds,
  previewHostRef,
}: PreviewPanelProps) => {
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const runnerStatus = useIdeStore((s) => s.runnerStatus);
  const runLogs = useIdeStore((s) => s.runLogs);
  const outputPanelOpen = useIdeStore((s) => s.outputPanelOpen);
  const previewError = useIdeStore((s) => s.previewError);
  const setOutputPanelOpen = useIdeStore((s) => s.setOutputPanelOpen);
  const setPreviewError = useIdeStore((s) => s.setPreviewError);
  const updateProject = useIdeStore((s) => s.updateProject);
  const startRunner = useIdeStore((s) => s.startRunner);
  const stopRunner = useIdeStore((s) => s.stopRunner);

  const activeRunnerStatus = activeProject
    ? (runnerStatus[activeProject.id] ?? "stopped")
    : "stopped";
  const runLog = activeProject ? (runLogs[activeProject.id] ?? "") : "";

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="h-8"
            disabled={!activeProject}
            onClick={
              activeRunnerStatus === "running"
                ? () => void stopRunner()
                : () => void startRunner()
            }
            size="sm"
            variant={activeRunnerStatus === "running" ? "secondary" : "default"}
          >
            {activeRunnerStatus === "running" ? (
              <>
                <Square className="mr-1.5 size-3.5" />
                Stop
              </>
            ) : (
              <>
                <Play className="mr-1.5 size-3.5" />
                Run
              </>
            )}
          </Button>
          <Button
            aria-label="Show output"
            className="h-8 w-8"
            disabled={outputPanelOpen}
            onClick={() => setOutputPanelOpen(true)}
            size="icon"
            title="Show output"
            variant="ghost"
          >
            <Logs className="size-4" />
          </Button>

          {activeProject ? (
            <>
              <Input
                className="h-8 min-w-52 flex-1 text-xs"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  updateProject(activeProject.id, (project) => ({
                    ...project,
                    runCommand: value,
                  }));
                }}
                value={activeProject.runCommand}
              />
              <Input
                className="h-8 min-w-52 flex-1 text-xs"
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  updateProject(activeProject.id, (project) => ({
                    ...project,
                    previewUrl: value,
                  }));
                }}
                value={activeProject.previewUrl}
              />
              <Button
                className="h-8"
                onClick={() => {
                  setPreviewError(null);
                  onSyncPreviewBounds();
                }}
                size="icon"
                variant="outline"
              >
                <RefreshCcw className="size-4" />
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <Group
        className="min-h-0 flex-1"
        id="ide-preview-output"
        orientation="vertical"
      >
        <Panel
          defaultSize={outputPanelOpen ? 74 : 100}
          id="ide-preview"
          minSize={30}
        >
          <div className="relative h-full">
            <div className="absolute inset-0" ref={previewHostRef} />
            {!activeProject || activeRunnerStatus !== "running" ? (
              <div className="absolute inset-0 p-3">
                <AppShellPlaceholder
                  message={
                    !activeProject
                      ? "Add a project and click Run to start a live preview."
                      : "Preview will appear here after you click Run."
                  }
                />
              </div>
            ) : null}
            {previewError ? (
              <div className="absolute right-3 bottom-3 left-3 rounded-md p-2 text-destructive text-xs shadow-sm">
                <div className="mb-1 flex items-center gap-1.5">
                  <AlertCircle className="size-3.5" />
                  Preview error
                </div>
                <p className="break-all">{previewError}</p>
              </div>
            ) : null}
          </div>
        </Panel>

        {outputPanelOpen ? (
          <>
            <ResizeHandle className="h-2 cursor-row-resize" id="ide-output-handle" />
            <Panel
              defaultSize={26}
              id="ide-output"
              minSize={`${TERMINAL_MIN_HEIGHT_PX}px`}
            >
              <div
                className="flex h-full min-h-0 flex-col"
                style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
              >
                <div className="flex items-center justify-between px-3 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Logs className="size-4" />
                    <span>Run output</span>
                  </div>
                  <Button
                    aria-label="Close output panel"
                    className="h-7 w-7 p-0"
                    onClick={() => setOutputPanelOpen(false)}
                    size="sm"
                    variant="ghost"
                  >
                    <X className="size-4" />
                  </Button>
                </div>
                <ScrollArea className="min-h-0 flex-1 px-3 py-2">
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-5">
                    {activeProject
                      ? runLog ||
                        "Run output will stream here after you start the project."
                      : "Select a project to view its run output."}
                  </pre>
                </ScrollArea>
              </div>
            </Panel>
          </>
        ) : null}
      </Group>
    </div>
  );
};
