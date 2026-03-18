import { ArrowLeft, ArrowRight, MoreVertical, RotateCw, X } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
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
import { AppShellPlaceholder } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { getPreviewTerminalSessionId } from "./ide-types";

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
  const setPreviewError = useIdeStore((s) => s.setPreviewError);
  const updateProject = useIdeStore((s) => s.updateProject);

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
      </div>

      {/* ── Preview ─────────────────────────────────────────────────────── */}
      <div className="min-h-0 flex-1">
        <div className="relative h-full" ref={previewContainerRef}>
          {activeProject && isPreviewRunning ? (
            <div className="absolute inset-0" ref={previewHostRef} />
          ) : null}
          {!activeProject ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Add a project to start a live preview." />
            </div>
          ) : !isPreviewRunning ? (
            <div className="absolute inset-0 p-3">
              <AppShellPlaceholder message="Run the project to show the live preview." />
            </div>
          ) : null}
        </div>
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
