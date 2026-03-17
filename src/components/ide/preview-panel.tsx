import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  MoreVertical,
  Play,
  RotateCw,
  Square,
  X,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import { FileExplorerPanel } from "./file-explorer-panel";
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

const PreviewViewport = ({
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
  const isPreviewRunning = activeRunnerStatus === "running";
  const isPreviewLoading = activeProject
    ? (previewLoading[activeProject.id] ?? false)
    : false;

  const projectName =
    activeProject?.path?.split(/[\\/]/).filter(Boolean).pop() ?? "Preview";

  useEffect(() => {
    setPreviewUrlDraft(activeProject?.previewUrl ?? "");
  }, [activeProject?.previewUrl]);

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
      className="flex h-full flex-col overflow-hidden rounded-lg border border-foreground/20 bg-background shadow-md"
    >
      {/* ── Browser Tab Bar ─────────────────────────────────────────────── */}
      <div className="flex items-end bg-muted/50 pl-1.5 pt-1.5">
        <div className="flex items-center gap-1.5 rounded-t-md bg-background px-3 py-1.5 text-xs font-medium">
          <span
            className={cn(
              "inline-block size-2 shrink-0 rounded-full",
              isPreviewRunning ? "bg-green-500" : "bg-muted-foreground/40",
            )}
          />
          <span className="max-w-[140px] truncate">
            {activeProject ? projectName : "Preview"}
          </span>
        </div>
        <div className="mb-0.5 ml-1 flex items-center">
          <button
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            type="button"
          >
            <MoreVertical className="size-3.5" />
          </button>
        </div>
      </div>

      {/* ── Navigation Bar ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-0.5 border-b border-foreground/10 px-1.5 py-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className="rounded p-1 text-muted-foreground/40 transition-colors"
                disabled
                type="button"
              />
            }
          >
            <ArrowLeft className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Go back</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className="rounded p-1 text-muted-foreground/40 transition-colors"
                disabled
                type="button"
              />
            }
          >
            <ArrowRight className="size-4" />
          </TooltipTrigger>
          <TooltipContent>Go forward</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <button
                className={cn(
                  "rounded p-1 transition-colors",
                  activeProject
                    ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                    : "text-muted-foreground/40",
                )}
                disabled={!activeProject}
                onClick={handlePreviewAction}
                type="button"
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
            {isPreviewLoading ? "Stop loading" : "Refresh preview"}
          </TooltipContent>
        </Tooltip>

        <div className="relative mx-1.5 flex-1">
          <Input
            className="h-7 rounded-full border-transparent bg-muted/40 px-3 text-xs focus:border-foreground/20"
            disabled={!activeProject}
            onChange={(event) => {
              setPreviewUrlDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !activeProject) {
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
            placeholder="Enter URL..."
            value={previewUrlDraft}
          />
          {isPreviewLoading ? (
            <div className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-2">
              <Spinner className="size-3.5 text-muted-foreground" />
            </div>
          ) : null}
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={isPreviewRunning ? "Stop" : "Run"}
                className="h-7 w-7"
                disabled={!activeProject}
                onClick={
                  isPreviewRunning
                    ? () => {
                        void stopRunner().then(() => onSyncPreviewBounds(true));
                      }
                    : () => void startRunner()
                }
                size="icon"
                variant="ghost"
              />
            }
          >
            {isPreviewRunning ? (
              <Square className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipContent>
            {isPreviewRunning ? "Stop runner" : "Start runner"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* ── Preview + Output ────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col">
        <Group
          className="min-h-0 flex-1"
          id="ide-preview-output"
          orientation="vertical"
        >
          <Panel
            defaultSize={outputPanelOpen ? 70 : 100}
            id="ide-preview"
            minSize={30}
          >
            <div className="relative h-full" ref={previewContainerRef}>
              {activeProject && isPreviewRunning ? (
                <div
                  className="absolute top-px right-[2px] bottom-[2px] left-[2px]"
                  ref={previewHostRef}
                />
              ) : null}
              {!activeProject ? (
                <div className="absolute inset-0 p-3">
                  <AppShellPlaceholder message="Add a project and click Run to start a live preview." />
                </div>
              ) : !isPreviewRunning ? (
                <div className="absolute inset-0 p-3">
                  <AppShellPlaceholder message="Run the project to show the live preview." />
                </div>
              ) : null}
            </div>
          </Panel>

          {outputPanelOpen ? (
            <>
              <ResizeHandle className="h-2" id="ide-output-handle" />
              <Panel
                defaultSize={30}
                id="ide-output"
                minSize={`${TERMINAL_MIN_HEIGHT_PX}px`}
              >
                {activeProject && previewTerminalSessionId ? (
                  <div className="flex h-full min-h-0 flex-col">
                    {/* Output header bar */}
                    <div className="flex items-center gap-2 border-t border-foreground/10 bg-muted/30 px-3 py-1.5">
                      <div className="flex items-center gap-3">
                        <span className="cursor-default text-xs font-medium uppercase text-muted-foreground">
                          all
                        </span>
                        <span className="cursor-default text-xs uppercase text-muted-foreground/40">
                          stdout
                        </span>
                        <span className="cursor-default text-xs uppercase text-muted-foreground/40">
                          stderr
                        </span>
                      </div>
                      <div className="ml-auto flex items-center gap-3">
                        <button
                          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          onClick={() => setOutputPanelOpen(false)}
                          type="button"
                        >
                          <ChevronDown className="size-4" />
                        </button>
                      </div>
                    </div>
                    {/* Terminal */}
                    <div className="min-h-0 flex-1">
                      <TerminalPanel
                        bordered={false}
                        onClose={() => setOutputPanelOpen(false)}
                        sessionId={previewTerminalSessionId}
                        showHeader={false}
                        stopOnClose={false}
                        subtitle={activeProject.runCommand}
                        title="Run Output"
                      />
                    </div>
                  </div>
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

        {/* Collapsed output toggle bar */}
        {!outputPanelOpen ? (
          <button
            className="flex w-full items-center justify-center border-t border-foreground/10 bg-muted/30 py-1 transition-colors hover:bg-muted/50"
            onClick={() => setOutputPanelOpen(true)}
            type="button"
          >
            <ChevronUp className="size-4 text-muted-foreground" />
          </button>
        ) : null}
      </div>
    </div>
  );
};

export const PreviewPanel = (props: PreviewPanelProps) => {
  const rightPanelView = useIdeStore((s) => s.rightPanelView);

  if (rightPanelView === "explorer") {
    return <FileExplorerPanel />;
  }

  return <PreviewViewport {...props} />;
};
