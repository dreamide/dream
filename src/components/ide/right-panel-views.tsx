import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { useUiStore } from "@/lib/ui-store";
import { cn } from "@/lib/utils";
import type { ProjectConfig } from "@/types/ide";
import { BrowserPanel } from "./browser-panel";
import { ChangesPanel } from "./changes-panel";
import { FileExplorerPanel } from "./file-explorer-panel";
import type { RightPanelView } from "./ide-types";

const RIGHT_PANEL_SURFACE_CLASSES =
  "overflow-hidden rounded-lg border border-foreground/20 bg-background text-foreground shadow-md";

export interface RightPanelViewsProps {
  active?: boolean;
  browserHostRef: RefObject<HTMLDivElement | null>;
  browserResizeHidden?: boolean;
  onSyncBrowserBounds: (reload?: boolean) => void;
  project: ProjectConfig;
  rightPanelView: RightPanelView;
}

const RightPanelViewSlot = ({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) => (
  <div
    aria-hidden={!active}
    className="absolute inset-0 min-h-0 overflow-hidden"
    style={{
      pointerEvents: active ? "auto" : "none",
      visibility: active ? "visible" : "hidden",
    }}
  >
    {children}
  </div>
);

export const RightPanelViews = (props: RightPanelViewsProps) => {
  const baseColor = useUiStore((state) => state.baseColor);
  const rightPanelView = props.rightPanelView;
  const onSyncBrowserBoundsRef = useRef(props.onSyncBrowserBounds);

  useEffect(() => {
    onSyncBrowserBoundsRef.current = props.onSyncBrowserBounds;
  }, [props.onSyncBrowserBounds]);

  const handleSyncBrowserBounds = useCallback((reload?: boolean) => {
    onSyncBrowserBoundsRef.current(reload);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col pt-2">
      <div
        className={cn(
          RIGHT_PANEL_SURFACE_CLASSES,
          "flex min-h-0 flex-1 flex-col",
        )}
        data-base-color={baseColor === "neutral" ? undefined : baseColor}
      >
        <div className="relative min-h-0 flex-1">
          <RightPanelViewSlot active={rightPanelView === "explorer"}>
            <FileExplorerPanel
              active={props.active}
              projectId={props.project.id}
            />
          </RightPanelViewSlot>
          <RightPanelViewSlot active={rightPanelView === "changes"}>
            <ChangesPanel projectId={props.project.id} />
          </RightPanelViewSlot>
          <RightPanelViewSlot active={rightPanelView === "browser"}>
            <BrowserPanel
              active={props.active}
              browserHostRef={props.browserHostRef}
              browserResizeHidden={props.browserResizeHidden}
              onSyncBrowserBounds={handleSyncBrowserBounds}
              project={props.project}
            />
          </RightPanelViewSlot>
        </div>
      </div>
    </div>
  );
};
