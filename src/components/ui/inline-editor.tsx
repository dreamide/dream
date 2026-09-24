import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Bordered surface for editable content with an InlineEditorFooter. */
function InlineEditor({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-editor"
      className={cn(
        "overflow-hidden rounded-lg border border-surface-300 bg-background shadow-xs dark:border-surface-700",
        "[&_[data-slot=input]]:rounded-none [&_[data-slot=input]]:border-0 [&_[data-slot=input]]:shadow-none dark:[&_[data-slot=input]]:bg-background",
        "[&_[data-slot=textarea]]:rounded-none [&_[data-slot=textarea]]:border-0 [&_[data-slot=textarea]]:shadow-none dark:[&_[data-slot=textarea]]:bg-background",
        className,
      )}
      {...props}
    />
  );
}

/** Place secondary actions first and the primary action last. */
function InlineEditorFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-editor-footer"
      className={cn(
        "flex flex-wrap justify-end gap-2 border-t border-surface-200 bg-surface-50 p-2 dark:border-surface-800 dark:bg-surface-900 [&_[data-slot=button]]:text-xs",
        className,
      )}
      {...props}
    />
  );
}

export { InlineEditor, InlineEditorFooter };
