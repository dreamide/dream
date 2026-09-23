import { useTranslations } from "next-intl";
import { useState } from "react";
import starSvg from "@/assets/star.svg";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIdeStore } from "../ide-store";
import { WorkspaceNavButton } from "../workspace/nav-button";
import { APP_VIEW_DESCRIPTORS, isAppView } from "../workspaces/registry";

// Vite can inline SVGs as data URLs containing spaces and parentheses.
const starMask = `url("${starSvg}") center / contain no-repeat`;

export const WorkspaceSwitcher = () => {
  const t = useTranslations("workspace");
  const appView = useIdeStore((s) => s.appView);
  const setAppView = useIdeStore((s) => s.setAppView);
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        render={
          <WorkspaceNavButton
            active={open}
            className="shrink-0"
            title={t("workspaces")}
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
          />
        }
      >
        <span
          aria-hidden="true"
          className="size-4 bg-current"
          style={{ mask: starMask, WebkitMask: starMask }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-48 [-webkit-app-region:no-drag]"
        side="bottom"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("workspaces")}</DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (isAppView(value)) setAppView(value);
          }}
          value={appView}
        >
          {APP_VIEW_DESCRIPTORS.map(({ icon: Icon, id, labelKey }) => (
            <DropdownMenuRadioItem closeOnClick key={id} value={id}>
              <Icon className="size-4" />
              {t(labelKey)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
