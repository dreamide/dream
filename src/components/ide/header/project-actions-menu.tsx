import { Ellipsis, ExternalLink, FilePenLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { DetectedEditor } from "@/types/ide";
import { OpenInEditorIcon } from "./open-in-editor-icon";
import type { ProjectEditTarget } from "./project-edit-dialog";
import type { ProjectTabItem } from "./project-tabs";

export const ProjectActionsMenu = ({
  closeProject,
  editors,
  isMacOs,
  onOpenInEditor,
  open,
  project,
  setEditTarget,
  setEditValue,
  setOpen,
}: {
  closeProject: (projectId: string) => void;
  editors: DetectedEditor[];
  isMacOs: boolean;
  onOpenInEditor: (
    project: {
      path: string;
    },
    editorId: string,
  ) => void;
  open: boolean;
  project: ProjectTabItem;
  setEditTarget: (target: ProjectEditTarget) => void;
  setEditValue: (value: string) => void;
  setOpen: (open: boolean) => void;
}) => (
  <div
    className={cn(
      "absolute top-1/2 right-0.5 -translate-y-1/2 transition-opacity",
      open ? "opacity-100" : "opacity-0 group-hover:opacity-100",
    )}
  >
    <DropdownMenu onOpenChange={setOpen} open={open}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`${project.label} actions`}
            className="h-8 w-8 bg-transparent p-0 hover:!bg-transparent data-[state=open]:!bg-transparent aria-expanded:!bg-transparent [-webkit-app-region:no-drag]"
            onClick={(event) => {
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <Ellipsis className="size-4 opacity-50 transition-opacity group-hover/button:opacity-100" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-44 [-webkit-app-region:no-drag]"
      >
        <DropdownMenuItem
          onClick={() => {
            setEditTarget({
              id: project.id,
              name: project.label,
            });
            setEditValue(project.label);
          }}
        >
          <FilePenLine className="size-4" />
          Edit
        </DropdownMenuItem>
        {editors.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <ExternalLink className="size-4" />
              Open in
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="[-webkit-app-region:no-drag]">
              {editors.map((editor) => (
                <DropdownMenuItem
                  key={editor.id}
                  onClick={() => onOpenInEditor(project, editor.id)}
                >
                  <OpenInEditorIcon editor={editor} isMacOs={isMacOs} />
                  {editor.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => closeProject(project.id)}>
          <X className="size-4" />
          Close
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
);
