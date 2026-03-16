import type { Terminal } from "@xterm/xterm";
import type { PropsWithChildren } from "react";
import { Button } from "@/components/ui/button";
import { ResizableHandle } from "@/components/ui/resizable";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const ResizeHandle = ({
  className,
  disabled,
  id,
}: {
  className?: string;
  disabled?: boolean;
  id?: string;
}) => (
  <ResizableHandle
    className={cn(
      "z-20 touch-none select-none bg-transparent",
      className,
      disabled && "!w-0 pointer-events-none opacity-0",
    )}
    disabled={disabled}
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
