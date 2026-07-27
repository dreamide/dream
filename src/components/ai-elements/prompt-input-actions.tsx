import { ImageIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { usePromptInputAttachments } from "./prompt-input-context";

export type PromptInputActionAddAttachmentsProps = ComponentProps<
  typeof DropdownMenuItem
> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({
  label,
  className,
  ...props
}: PromptInputActionAddAttachmentsProps) => {
  const uiT = useTranslations("ui");
  const attachments = usePromptInputAttachments();

  const handleClick = useCallback(() => {
    attachments.openFileDialog();
  }, [attachments]);

  return (
    <DropdownMenuItem
      className={cn("min-w-44 whitespace-nowrap text-xs", className)}
      {...props}
      onClick={handleClick}
    >
      <ImageIcon className="mr-2 size-3.5 shrink-0" />
      <span className="truncate">{label ?? uiT("addPhotosOrFiles")}</span>
    </DropdownMenuItem>
  );
};
