"use client";

import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { TerminalSquare, X } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import { echoPipeFallbackInput } from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { TERMINAL_MIN_HEIGHT_PX } from "./ide-types";

export interface TerminalPanelProps {
  sessionId: string;
  title?: string;
  subtitle?: string;
  autoStart?: boolean;
  bordered?: boolean;
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
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    transportRef.current = terminalTransport;
  }, [terminalTransport]);

  useEffect(() => {
    statusRef.current = terminalStatus;
  }, [terminalStatus]);

  useEffect(() => {
    if (!resolvedTheme) {
      return;
    }

    const terminal = terminalInstanceRef.current;
    if (!terminal) {
      return;
    }

    const rootStyles = getComputedStyle(document.documentElement);
    terminal.options.theme = {
      background: rootStyles.getPropertyValue("--background").trim(),
      cursor: rootStyles.getPropertyValue("--foreground").trim(),
      foreground: rootStyles.getPropertyValue("--foreground").trim(),
      selectionBackground: rootStyles.getPropertyValue("--accent").trim(),
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const rootStyles = getComputedStyle(document.documentElement);

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      theme: {
        background: rootStyles.getPropertyValue("--background").trim(),
        cursor: rootStyles.getPropertyValue("--foreground").trim(),
        foreground: rootStyles.getPropertyValue("--foreground").trim(),
        selectionBackground: rootStyles.getPropertyValue("--accent").trim(),
      },
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
    <div
      className={`flex h-full min-h-0 flex-col${bordered ? " border-t border-foreground/20" : ""}`}
      style={{ minHeight: TERMINAL_MIN_HEIGHT_PX }}
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs">
        <div className="flex items-center gap-2">
          <TerminalSquare className="size-4" />
          <span>{title}</span>
          <span className="text-muted-foreground">{shellLabel}</span>
        </div>
        <Button
          aria-label={`Close ${title.toLowerCase()}`}
          className="h-7 w-7 p-0"
          onClick={() => {
            onClose();
            if (stopOnClose) {
              void onStop?.();
            }
          }}
          size="sm"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 p-2">
        <div className="h-full w-full" ref={hostRef} />
      </div>
    </div>
  );
};
