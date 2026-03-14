"use client";

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getDesktopApi } from "@/lib/electron";
import { cn } from "@/lib/utils";
import { echoPipeFallbackInput } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { TERMINAL_MIN_HEIGHT_PX } from "./ide-types";

const EMPTY_TERMINAL_SESSION_IDS: string[] = [];
const TERMINAL_SURFACE_CLASS =
  "overflow-hidden rounded-lg bg-[#0b1020] text-slate-100";
const TERMINAL_HOST_CLASS =
  "h-full w-full overflow-hidden rounded-lg bg-[#0a0f1d]";
const TERMINAL_THEME = {
  background: "#0a0f1d",
  cursor: "#f8fafc",
  foreground: "#e2e8f0",
  selectionBackground: "rgba(96, 165, 250, 0.3)",
};

export interface TerminalPanelProps {
  sessionId: string;
  title?: string;
  subtitle?: string;
  autoStart?: boolean;
  bordered?: boolean;
  showHeader?: boolean;
  onClose: () => void;
  onStart?: () => Promise<void> | void;
  onStop?: () => Promise<void> | void;
  stopOnClose?: boolean;
}

export const TerminalPanel = ({
  sessionId,
  title = "Terminal",
  subtitle,
  autoStart = false,
  bordered = true,
  showHeader = true,
  onClose,
  onStart,
  onStop,
  stopOnClose = true,
}: TerminalPanelProps) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalInstanceRef = useRef<Terminal | null>(null);
  const transportRef = useRef(
    useIdeStore.getState().terminalTransport[sessionId] ?? "pty",
  );
  const statusRef = useRef(
    useIdeStore.getState().terminalStatus[sessionId] ?? "stopped",
  );
  const terminalShell = useIdeStore((s) => s.terminalShell[sessionId]);
  const terminalStatus = useIdeStore(
    (s) => s.terminalStatus[sessionId] ?? "stopped",
  );
  const terminalTransport = useIdeStore(
    (s) => s.terminalTransport[sessionId] ?? "pty",
  );

  useEffect(() => {
    transportRef.current = terminalTransport;
  }, [terminalTransport]);

  useEffect(() => {
    statusRef.current = terminalStatus;
  }, [terminalStatus]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      theme: TERMINAL_THEME,
    });
    terminalInstanceRef.current = terminal;

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);
    fitAddon.fit();
    terminal.focus();

    const initialOutput =
      useIdeStore.getState().terminalOutput[sessionId] ?? "";
    if (initialOutput) {
      terminal.write(initialOutput);
    }

    if (autoStart && statusRef.current !== "running") {
      void onStart?.();
    }

    const desktopApi = getDesktopApi();
    const removeTerminalData = desktopApi?.onTerminalData((event) => {
      if (event.projectId !== sessionId) {
        return;
      }

      terminal.write(event.chunk);
    });

    const inputSubscription = terminal.onData((data) => {
      const api = getDesktopApi();
      if (!api) {
        return;
      }

      if (transportRef.current === "pipe") {
        echoPipeFallbackInput(terminal, data);
      }

      api.sendTerminalInput({
        data,
        projectId: sessionId,
      });
    });

    const fit = () => {
      fitAddon.fit();
    };

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);
    window.addEventListener("resize", fit);

    return () => {
      removeTerminalData?.();
      inputSubscription.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", fit);
      terminalInstanceRef.current = null;
      terminal.dispose();
    };
  }, [autoStart, onStart, sessionId]);

  const shellLabel = subtitle ?? terminalShell ?? "system shell";

  return (
    <div className={cn("flex h-full min-h-0 flex-col", bordered ? "pt-2" : "")}>
      {showHeader ? (
        <div className="min-h-0 flex-1 p-2">
          <div
            className={cn(
              "flex h-full min-h-0 flex-col",
              TERMINAL_SURFACE_CLASS,
            )}
            style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
          >
            <div className="flex items-center justify-between px-3 py-1.5 text-slate-100 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <TerminalSquare className="size-4 shrink-0 text-slate-300" />
                <span className="truncate font-medium">{title}</span>
                <span className="truncate text-slate-400">{shellLabel}</span>
              </div>
              <Button
                aria-label={`Close ${title.toLowerCase()}`}
                className="h-7 w-7 p-0 text-slate-300 hover:bg-white/8 hover:text-white"
                onClick={() => {
                  onClose();
                  if (stopOnClose) {
                    void onStop?.();
                  }
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 p-2">
              <div className={TERMINAL_HOST_CLASS} ref={hostRef} />
            </div>
          </div>
        </div>
      ) : null}
      {!showHeader ? (
        <div className="min-h-0 flex-1 p-2">
          <div className={TERMINAL_HOST_CLASS} ref={hostRef} />
        </div>
      ) : null}
    </div>
  );
};

export const ProjectTerminalTabsPanel = ({
  projectId,
}: {
  projectId: string;
}) => {
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds,
  );
  const sessionIds =
    projectTerminalSessionIds[projectId] ?? EMPTY_TERMINAL_SESSION_IDS;
  const activeSessionId = useIdeStore(
    (s) => s.activeTerminalSessionIdByProject[projectId] ?? null,
  );
  const terminalShell = useIdeStore((s) =>
    activeSessionId ? s.terminalShell[activeSessionId] : undefined,
  );
  const addProjectTerminal = useIdeStore((s) => s.addProjectTerminal);
  const closeProjectTerminal = useIdeStore((s) => s.closeProjectTerminal);
  const setActiveProjectTerminalId = useIdeStore(
    (s) => s.setActiveProjectTerminalId,
  );

  const resolvedActiveSessionId =
    activeSessionId && sessionIds.includes(activeSessionId)
      ? activeSessionId
      : (sessionIds[0] ?? null);
  const activeTabIndex = resolvedActiveSessionId
    ? sessionIds.indexOf(resolvedActiveSessionId)
    : -1;

  if (!resolvedActiveSessionId) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      <div
        className={cn("flex min-h-0 flex-1 flex-col", TERMINAL_SURFACE_CLASS)}
        style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
      >
        <div className="flex items-center gap-2 px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <TerminalSquare className="size-4 shrink-0 text-slate-300" />
            <Tabs
              className="min-w-0 flex-1"
              onValueChange={(value) =>
                setActiveProjectTerminalId(projectId, value)
              }
              value={resolvedActiveSessionId}
            >
              <TabsList className="h-8 max-w-full justify-start overflow-x-auto bg-white/6">
                {sessionIds.map((sessionId, index) => (
                  <div className="relative shrink-0" key={sessionId}>
                    <TabsTrigger
                      className="h-6 shrink-0 px-2 pr-9 text-slate-400 text-xs hover:text-slate-100 data-[active]:bg-white/10 data-[active]:text-slate-50"
                      value={sessionId}
                    >
                      <span className="truncate">Terminal {index + 1}</span>
                    </TabsTrigger>
                    <button
                      aria-label={`Close terminal ${index + 1}`}
                      className="-translate-y-1/2 absolute top-1/2 right-1.5 rounded p-0.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-50"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        void closeProjectTerminal(projectId, sessionId);
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      type="button"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
                <Button
                  aria-label="Open another terminal"
                  className="ml-2 h-6 w-6 shrink-0 rounded-md p-0 text-slate-300 hover:bg-white/10 hover:text-white"
                  onClick={() => void addProjectTerminal(projectId)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Plus className="size-3.5" />
                </Button>
              </TabsList>
            </Tabs>
          </div>
          <span className="truncate text-slate-400 text-xs">
            {terminalShell ?? "system shell"}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <TerminalPanel
            bordered={false}
            onClose={() =>
              void closeProjectTerminal(projectId, resolvedActiveSessionId)
            }
            sessionId={resolvedActiveSessionId}
            showHeader={false}
            stopOnClose={false}
            subtitle={terminalShell}
            title={
              activeTabIndex >= 0
                ? `Terminal ${activeTabIndex + 1}`
                : "Terminal"
            }
          />
        </div>
      </div>
    </div>
  );
};
