import type { Terminal } from "@xterm/xterm";
import type { PropsWithChildren } from "react";
import { ResizableHandle } from "@/components/ui/resizable";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const ResizeHandle = ({
  className,
  id,
}: {
  className?: string;
  id?: string;
}) => (
  <ResizableHandle
    className={cn(
      "z-20 touch-none select-none bg-transparent",
      className,
    )}
    id={id}
  />
);

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
    title={title}
    variant="ghost"
  >
    {children}
  </Button>
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
