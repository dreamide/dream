import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useTheme } from "next-themes";
import { type HTMLAttributes, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import { echoPipeFallbackInput } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { TERMINAL_MIN_HEIGHT_PX } from "./ide-types";
import { StandardTabs } from "./standard-tabs";

const EMPTY_TERMINAL_SESSION_IDS: string[] = [];
const TERMINAL_SURFACE_CLASSES =
  "overflow-hidden rounded-lg border border-foreground/20 bg-background text-foreground shadow-md";
const TERMINAL_HOST_CLASS = "h-full w-full overflow-hidden";
const TERMINAL_FONT_FAMILY_FALLBACK =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const getDefaultTerminalName = (index: number) => `Terminal ${index + 1}`;

const formatTerminalShellLabel = (value?: string) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return "system shell";
  }

  const executable = trimmed
    .split(/\s+/)[0]
    ?.split(/[\\/]/)
    .pop()
    ?.toLowerCase();

  if (executable === "pwsh" || executable === "pwsh.exe") {
    return "PowerShell";
  }

  if (executable === "powershell" || executable === "powershell.exe") {
    return "PowerShell";
  }

  if (executable === "cmd" || executable === "cmd.exe") {
    return "Command Prompt";
  }

  if (executable === "bash") {
    return "bash";
  }

  if (executable === "zsh") {
    return "zsh";
  }

  if (executable === "sh") {
    return "sh";
  }

  return executable || trimmed;
};

const TerminalSurface = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => {
  const baseColor = useUiStore((s) => s.baseColor);

  return (
    <div
      className={cn(TERMINAL_SURFACE_CLASSES, className)}
      data-base-color={baseColor === "neutral" ? undefined : baseColor}
      {...props}
    />
  );
};

const resolveTerminalTheme = (host: HTMLElement, resolvedTheme?: string) => {
  const style = getComputedStyle(host);
  const bg = style.getPropertyValue("--background").trim();
  const fg = style.getPropertyValue("--foreground").trim();
  const accent = style.getPropertyValue("--ring").trim();
  const primary = style.getPropertyValue("--primary").trim();
  const destructive = style.getPropertyValue("--destructive").trim();
  const muted = style.getPropertyValue("--muted").trim();
  const mutedForeground = style.getPropertyValue("--muted-foreground").trim();
  const chart1 = style.getPropertyValue("--chart-1").trim();
  const chart2 = style.getPropertyValue("--chart-2").trim();
  const chart3 = style.getPropertyValue("--chart-3").trim();
  const chart4 = style.getPropertyValue("--chart-4").trim();
  const chart5 = style.getPropertyValue("--chart-5").trim();
  const isDark = resolvedTheme === "dark";

  const ansi = isDark
    ? {
        black: muted || "#1f2937",
        red: destructive || "#f87171",
        green: chart2 || "#4ade80",
        yellow: chart3 || "#fbbf24",
        blue: primary || chart1 || "#60a5fa",
        magenta: chart4 || "#c084fc",
        cyan: chart5 || "#22d3ee",
        white: fg || "#e5e7eb",
        brightBlack: mutedForeground || "#9ca3af",
        brightRed: destructive || "#fca5a5",
        brightGreen: chart2 || "#86efac",
        brightYellow: chart3 || "#fcd34d",
        brightBlue: primary || chart1 || "#93c5fd",
        brightMagenta: chart4 || "#d8b4fe",
        brightCyan: chart5 || "#67e8f9",
        brightWhite: "#ffffff",
      }
    : {
        black: fg || "#111827",
        red: destructive || "#b91c1c",
        green: chart2 || "#166534",
        yellow: chart3 || "#92400e",
        blue: primary || chart1 || "#1d4ed8",
        magenta: chart4 || "#7e22ce",
        cyan: chart5 || "#155e75",
        white: muted || "#d1d5db",
        brightBlack: mutedForeground || "#4b5563",
        brightRed: destructive || "#dc2626",
        brightGreen: chart2 || "#15803d",
        brightYellow: chart3 || "#a16207",
        brightBlue: primary || chart1 || "#2563eb",
        brightMagenta: chart4 || "#9333ea",
        brightCyan: chart5 || "#0f766e",
        brightWhite: bg || "#f9fafb",
      };

  return {
    background: bg || "#0a0f1d",
    cursor: fg || "#f8fafc",
    foreground: fg || "#e2e8f0",
    selectionBackground: accent || "rgba(96, 165, 250, 0.3)",
    ...ansi,
  };
};

const resolveCssCustomProperty = (
  style: CSSStyleDeclaration,
  name: string,
  seen = new Set<string>(),
): string => {
  if (seen.has(name)) {
    return "";
  }

  seen.add(name);

  const value = style.getPropertyValue(name).trim();
  const variableMatch = value.match(/^var\((--[\w-]+)(?:,\s*(.+))?\)$/);

  if (!variableMatch) {
    return value;
  }

  const [, variableName, fallback] = variableMatch;
  return (
    resolveCssCustomProperty(style, variableName, seen) ||
    fallback?.trim() ||
    ""
  );
};

const resolveTerminalFontFamily = (host: HTMLElement) => {
  const style = getComputedStyle(host);
  return (
    resolveCssCustomProperty(style, "--font-mono") ||
    resolveCssCustomProperty(style, "--font-jetbrains-mono") ||
    TERMINAL_FONT_FAMILY_FALLBACK
  );
};

export interface TerminalPanelProps {
  sessionId: string;
  title?: string;
  subtitle?: string;
  autoStart?: boolean;
  bordered?: boolean;
  isActive?: boolean;
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
  isActive = true,
  showHeader = true,
  onClose,
  onStart,
  onStop,
  stopOnClose = true,
}: TerminalPanelProps) => {
  const { resolvedTheme } = useTheme();
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
  const terminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    transportRef.current = terminalTransport;

    const terminal = terminalInstanceRef.current;
    if (terminal) {
      terminal.options.convertEol = terminalTransport === "pipe";
    }
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
      convertEol: transportRef.current === "pipe",
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: resolveTerminalFontFamily(host),
      fontSize: 12,
      theme: resolveTerminalTheme(host, resolvedTheme),
    });
    terminalInstanceRef.current = terminal;

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(host);

    let resizeFrame: number | null = null;

    const fitAndSyncSize = () => {
      resizeFrame = null;
      fitAddon.fit();

      const cols = terminal.cols;
      const rows = terminal.rows;

      if (cols < 2 || rows < 1) {
        return;
      }

      const previousSize = terminalSizeRef.current;
      if (previousSize?.cols === cols && previousSize.rows === rows) {
        return;
      }

      terminalSizeRef.current = { cols, rows };
      getDesktopApi()?.resizeTerminal({
        cols,
        projectId: sessionId,
        rows,
      });
    };

    const scheduleFitAndSyncSize = () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }

      resizeFrame = window.requestAnimationFrame(fitAndSyncSize);
    };

    fitAndSyncSize();

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

    const resizeObserver = new ResizeObserver(scheduleFitAndSyncSize);
    resizeObserver.observe(host);
    window.addEventListener("resize", scheduleFitAndSyncSize);

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      removeTerminalData?.();
      inputSubscription.dispose();
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleFitAndSyncSize);
      terminalInstanceRef.current = null;
      terminal.dispose();
    };
  }, [autoStart, onStart, resolvedTheme, sessionId]);

  useEffect(() => {
    if (!isActive) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      terminalInstanceRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isActive]);

  useEffect(() => {
    if (!resolvedTheme) {
      return;
    }

    const host = hostRef.current;
    const terminal = terminalInstanceRef.current;
    if (!host || !terminal) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      terminal.options.theme = resolveTerminalTheme(host, resolvedTheme);
      terminal.refresh(0, terminal.rows - 1);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [resolvedTheme]);

  const shellLabel = formatTerminalShellLabel(subtitle ?? terminalShell);

  return (
    <div className={cn("flex h-full min-h-0 flex-col", bordered ? "pt-2" : "")}>
      {showHeader ? (
        <div className="min-h-0 flex-1 p-2">
          <TerminalSurface
            className="flex h-full min-h-0 flex-col"
            style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
          >
            <div className="flex items-center justify-between px-3 py-1.5 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-medium">{title}</span>
                <span className="truncate text-muted-foreground">
                  {shellLabel}
                </span>
              </div>
              <Button
                aria-label={`Close ${title.toLowerCase()}`}
                className="h-7 w-7 p-0 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
          </TerminalSurface>
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
  active = true,
  projectId,
}: {
  active?: boolean;
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
  const addProjectTerminal = useIdeStore((s) => s.addProjectTerminal);
  const closeProjectTerminal = useIdeStore((s) => s.closeProjectTerminal);
  const terminalSessionNames = useIdeStore((s) => s.terminalSessionNames);
  const setTerminalSessionName = useIdeStore((s) => s.setTerminalSessionName);
  const setActiveProjectTerminalId = useIdeStore(
    (s) => s.setActiveProjectTerminalId,
  );
  const reorderProjectTerminals = useIdeStore((s) => s.reorderProjectTerminals);

  const resolvedActiveSessionId =
    activeSessionId && sessionIds.includes(activeSessionId)
      ? activeSessionId
      : (sessionIds[0] ?? null);

  const resolveTerminalName = (sessionId: string, index: number) =>
    terminalSessionNames[sessionId]?.trim() || getDefaultTerminalName(index);
  const terminalTabItems = sessionIds.map((sessionId, index) => ({
    id: sessionId,
    label: resolveTerminalName(sessionId, index),
  }));

  useEffect(() => {
    for (const [index, sessionId] of sessionIds.entries()) {
      if (terminalSessionNames[sessionId]?.trim()) {
        continue;
      }

      setTerminalSessionName(sessionId, getDefaultTerminalName(index));
    }
  }, [sessionIds, setTerminalSessionName, terminalSessionNames]);

  if (!resolvedActiveSessionId) {
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col py-2 pr-2">
      <TerminalSurface
        className="flex min-h-0 flex-1 flex-col"
        style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
      >
        <div className="flex items-center gap-2 border-b border-foreground/10 bg-muted/50 px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
            <StandardTabs
              activeId={resolvedActiveSessionId}
              after={
                <Button
                  aria-label="Open another terminal"
                  className="h-8 w-8 shrink-0 rounded-lg p-0 text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                  onClick={() => void addProjectTerminal(projectId)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Plus className="size-4" />
                </Button>
              }
              ariaLabel="Terminal tabs"
              canClose={true}
              className="flex-1"
              closeAriaLabel={(tab) => `Close ${tab.label.toLowerCase()}`}
              items={terminalTabItems}
              onActivate={(sessionId) =>
                setActiveProjectTerminalId(projectId, sessionId)
              }
              onClose={(sessionId) =>
                void closeProjectTerminal(projectId, sessionId)
              }
              onRename={(sessionId, label) =>
                setTerminalSessionName(sessionId, label)
              }
              onReorder={(fromIndex, toIndex) =>
                reorderProjectTerminals(projectId, fromIndex, toIndex)
              }
              renameOnDoubleClick={true}
            />
          </div>
        </div>
        <div className="relative min-h-0 flex-1">
          {sessionIds.map((sessionId, index) => {
            const isActive = sessionId === resolvedActiveSessionId;

            return (
              <div
                aria-hidden={!isActive}
                className={cn(
                  "absolute inset-0 min-h-0",
                  isActive
                    ? "visible pointer-events-auto"
                    : "invisible pointer-events-none",
                )}
                inert={!isActive}
                key={sessionId}
              >
                <TerminalPanel
                  bordered={false}
                  isActive={active && isActive}
                  onClose={() =>
                    void closeProjectTerminal(projectId, sessionId)
                  }
                  sessionId={sessionId}
                  showHeader={false}
                  stopOnClose={false}
                  title={resolveTerminalName(sessionId, index)}
                />
              </div>
            );
          })}
        </div>
      </TerminalSurface>
    </div>
  );
};
