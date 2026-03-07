import { Logs, Play, RotateCw, Square, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Group, Panel } from "react-resizable-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDesktopApi } from "@/lib/electron";
import { AppShellPlaceholder, ResizeHandle } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import {
  getPreviewTerminalSessionId,
  TERMINAL_MIN_HEIGHT_PX,
} from "./ide-types";
import { TerminalPanel } from "./terminal-panel";

export interface PreviewPanelProps {
  onSyncPreviewBounds: (reload?: boolean) => void;
  previewHostRef: RefObject<HTMLDivElement | null>;
}

export const PreviewPanel = ({
  onSyncPreviewBounds,
  previewHostRef,
}: PreviewPanelProps) => {
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const [previewUrlDraft, setPreviewUrlDraft] = useState("");
  const activeProject = useIdeStore((s) => s.getActiveProject());
  const terminalStatus = useIdeStore((s) => s.terminalStatus);
  const previewLoading = useIdeStore((s) => s.previewLoading);
  const outputPanelOpen = useIdeStore((s) => s.outputPanelOpen);
  const setOutputPanelOpen = useIdeStore((s) => s.setOutputPanelOpen);
  const setPreviewError = useIdeStore((s) => s.setPreviewError);
  const updateProject = useIdeStore((s) => s.updateProject);
  const startRunner = useIdeStore((s) => s.startRunner);
  const stopRunner = useIdeStore((s) => s.stopRunner);

  const previewTerminalSessionId = activeProject
    ? getPreviewTerminalSessionId(activeProject.id)
    : null;
  const activeRunnerStatus = previewTerminalSessionId
    ? (terminalStatus[previewTerminalSessionId] ?? "stopped")
    : "stopped";
  const isPreviewLoading = activeProject
    ? (previewLoading[activeProject.id] ?? false)
    : false;

  useEffect(() => {
    setPreviewUrlDraft(activeProject?.previewUrl ?? "");
  }, [activeProject?.id, activeProject?.previewUrl]);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;

    const sync = () => onSyncPreviewBounds();
    const observer = new ResizeObserver(sync);
    observer.observe(container);

    const frame = window.requestAnimationFrame(sync);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [onSyncPreviewBounds]);

  const handlePreviewAction = () => {
    if (!activeProject) {
      return;
    }

    if (isPreviewLoading) {
      getDesktopApi()?.updatePreview({
        projectId: activeProject.id,
        stop: true,
      });
      return;
    }

    setPreviewError(null);
    onSyncPreviewBounds(true);
  };

  return (
    <div
      id="preview-panel"
      className="flex h-full flex-col border border-foreground/20 rounded-lg pb-4 shadow-md"
    >
      <div id="preview-controls" className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="h-8"
            disabled={!activeProject}
            onClick={
              activeRunnerStatus === "running"
                ? () => {
                    void stopRunner().then(() => onSyncPreviewBounds(true));
                  }
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Show output"
                  className="h-8 w-8"
                  disabled={outputPanelOpen}
                  onClick={() => setOutputPanelOpen(true)}
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <Logs className="size-4" />
            </TooltipTrigger>
            <TooltipContent>Show output</TooltipContent>
          </Tooltip>

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
              <div className="relative min-w-52 flex-1">
                <Input
                  className="h-8 w-full pr-8 text-xs"
                  onChange={(event) => {
                    setPreviewUrlDraft(event.currentTarget.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter") {
                      return;
                    }

                    event.preventDefault();

                    const value = previewUrlDraft.trim();
                    if (!value || value === activeProject.previewUrl) {
                      return;
                    }

                    setPreviewError(null);
                    updateProject(activeProject.id, (project) => ({
                      ...project,
                      previewUrl: value,
                    }));
                  }}
                  value={previewUrlDraft}
                />
                {isPreviewLoading ? (
                  <div className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2 text-muted-foreground">
                    <Spinner className="size-4" />
                  </div>
                ) : null}
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={
                        isPreviewLoading
                          ? "Stop loading preview"
                          : "Refresh preview"
                      }
                      className="h-8"
                      onClick={handlePreviewAction}
                      size="icon"
                      variant="outline"
                    />
                  }
                >
                  {isPreviewLoading ? (
                    <X className="size-4" />
                  ) : (
                    <RotateCw className="size-4" />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {isPreviewLoading
                    ? "Stop loading preview"
                    : "Refresh preview"}
                </TooltipContent>
              </Tooltip>
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
          <div className="relative h-full" ref={previewContainerRef}>
            <div
              className="absolute top-px right-[2px] bottom-[6px] left-[2px]"
              ref={previewHostRef}
            />
            <div className="pointer-events-none absolute right-0 bottom-0 h-4 w-4 rounded-tl-lg bg-background" />
            <div className="pointer-events-none absolute bottom-0 left-0 h-4 w-4 rounded-tr-lg bg-background" />
            {!activeProject ? (
              <div className="absolute inset-0 p-3">
                <AppShellPlaceholder message="Add a project and click Run to start a live preview." />
              </div>
            ) : null}
          </div>
        </Panel>

        {outputPanelOpen ? (
          <>
            <ResizeHandle
              className="h-2 cursor-row-resize"
              id="ide-output-handle"
            />
            <Panel
              defaultSize={26}
              id="ide-output"
              minSize={`${TERMINAL_MIN_HEIGHT_PX}px`}
            >
              {activeProject && previewTerminalSessionId ? (
                <TerminalPanel
                  bordered
                  onClose={() => setOutputPanelOpen(false)}
                  sessionId={previewTerminalSessionId}
                  stopOnClose={false}
                  subtitle={activeProject.runCommand}
                  title="Run Output"
                />
              ) : (
                <div
                  className="flex h-full min-h-0 items-center justify-center px-3 text-muted-foreground text-sm"
                  style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
                >
                  Select a project to view its run output.
                </div>
              )}
            </Panel>
          </>
        ) : null}
      </Group>
    </div>
  );
};
