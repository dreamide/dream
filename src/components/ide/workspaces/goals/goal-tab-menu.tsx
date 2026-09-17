import { Ellipsis, FilePenLine, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export const GoalTabMenu = ({
  title,
  onEdit,
  onClose,
}: {
  title: string;
  onEdit: () => void;
  onClose: () => void;
}) => {
  const t = useTranslations("common");
  const goalsT = useTranslations("goals");
  const [open, setOpen] = useState(false);
  return (
    <div
      className={cn(
        "absolute top-1/2 right-0.5 -translate-y-1/2 transition-opacity",
        open
          ? "opacity-100"
          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
      )}
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={goalsT("goalActions", { name: title })}
              className="h-8 w-8 bg-transparent p-0 hover:!bg-transparent data-[state=open]:!bg-transparent aria-expanded:!bg-transparent"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              size="icon-sm"
              type="button"
              variant="ghost"
            />
          }
        >
          <Ellipsis className="size-4 opacity-50 transition-opacity group-hover/button:opacity-100" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={onEdit}>
            <FilePenLine className="size-4" />
            {t("edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onClose}>
            <X className="size-4" />
            {t("close")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
