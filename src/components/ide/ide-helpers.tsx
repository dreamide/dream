import type { Terminal } from "@xterm/xterm";
import type { PropsWithChildren } from "react";
import { useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ── Panel resize handle ───────────────────────────────────────────────

/**
 * A draggable resize handle placed between two panels.
 *
 * `side` indicates which panel the handle resizes:
 * - `"right"` — the handle sits on the right edge of a left-aligned panel;
 *   dragging right increases width (positive delta).
 * - `"left"` — the handle sits on the left edge of a right-aligned panel;
 *   dragging left increases width (negative delta → positive growth).
 */
export const PanelResizeHandle = ({
  onResizeStart,
  onResize,
  onResizeEnd,
  side,
}: {
  onResizeStart?: () => void;
  onResize: (deltaX: number) => void;
  onResizeEnd?: () => void;
  side: "left" | "right";
}) => {
  const draggingRef = useRef(false);
  const startXRef = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      onResizeStart?.();

      // Capture pointer so we get events even if cursor leaves the handle
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [onResizeStart],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      const delta = e.clientX - startXRef.current;
      onResize(side === "right" ? delta : -delta);
    },
    [onResize, side],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      onResizeEnd?.();
    },
    [onResizeEnd],
  );

  // Prevent text selection globally while dragging
  useEffect(() => {
    const onSelectStart = (e: Event) => {
      if (draggingRef.current) e.preventDefault();
    };
    document.addEventListener("selectstart", onSelectStart);
    return () => document.removeEventListener("selectstart", onSelectStart);
  }, []);

  return (
    <div
      className="group relative z-20 flex shrink-0 touch-none select-none items-center justify-center"
      style={{ width: 7 }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Invisible hit area with col-resize cursor */}
      <div className="absolute inset-y-0 -left-1 -right-1 cursor-col-resize" />
    </div>
  );
};

export const ToggleButton = ({
  active,
  children,
  disabled,
  onClick,
  title,
}: PropsWithChildren<{
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}>) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          aria-label={title}
          className={cn(
            "size-8 [-webkit-app-region:no-drag]",
            active
              ? "text-foreground hover:text-foreground"
              : "text-muted-foreground/50 hover:text-foreground",
          )}
          disabled={disabled}
          onClick={onClick}
          size="icon"
          variant="ghost"
        />
      }
    >
      {children}
    </TooltipTrigger>
    <TooltipContent>{title}</TooltipContent>
  </Tooltip>
);

export const AppShellPlaceholder = ({ message }: { message: string }) => (
  <div className="flex h-full items-center justify-center p-4 text-center text-muted-foreground text-sm">
    {message}
  </div>
);

export const echoPipeFallbackInput = (terminal: Terminal, data: string) => {
  let echoed = "";

  for (const char of data) {
    const code = char.charCodeAt(0);

    if (char === "\r" || char === "\n") {
      echoed += "\r\n";
      continue;
    }

    if (char === "\u007f") {
      echoed += "\b \b";
      continue;
    }

    if (code === 0x03) {
      echoed += "^C\r\n";
      continue;
    }

    if (char === "\u001b" || code < 0x20) {
      continue;
    }

    echoed += char;
  }

  if (echoed) {
    terminal.write(echoed);
  }
};
