import { Minus, Square, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { getDesktopApi } from "@/lib/electron";

export const WindowControls = () => {
  const commonT = useTranslations("common");
  const api = getDesktopApi();

  return (
    <div className="flex h-full items-stretch [-webkit-app-region:no-drag]">
      <button
        aria-label={commonT("minimize")}
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => api?.windowMinimize()}
        type="button"
      >
        <Minus className="size-3.5" />
      </button>
      <button
        aria-label={commonT("maximize")}
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => api?.windowMaximize()}
        type="button"
      >
        <Square className="size-3" />
      </button>
      <button
        aria-label={commonT("close")}
        className="flex w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white active:bg-red-700 dark:hover:bg-red-500 dark:hover:text-white dark:active:bg-red-600"
        onClick={() => api?.windowClose()}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
};
