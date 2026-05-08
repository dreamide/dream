import {
  type MutableRefObject,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import type { ProjectConfig, RightPanelView } from "@/types/ide";
import { BrowserPanel } from "../browser-panel";
import { PanelResizeHandle } from "../ide-helpers";
import {
  BROWSER_PANEL_MIN_WIDTH_PX,
  PANEL_RESIZE_HANDLE_SIZE_PX,
} from "./constants";

export interface WorkspaceRightPanelProps {
  active: boolean;
  browserHostRef: RefObject<HTMLDivElement | null>;
  browserResizeHidden: boolean;
  handleVisible: boolean;
  maxWidth: number;
  onResizeEnd: (width: number) => void;
  onResizeStart: () => void;
  onSyncBrowserBounds: (reload?: boolean) => void;
  onToggleRightPanel: () => void;
  open: boolean;
  project: ProjectConfig;
  rightPanelRef: RefObject<HTMLDivElement | null>;
  rightPanelTransition: string;
  rightPanelView: RightPanelView;
  width: number;
  widthRef: MutableRefObject<number>;
}

export const WorkspaceRightPanel = ({
  active,
  browserHostRef,
  browserResizeHidden,
  handleVisible,
  maxWidth,
  onResizeEnd,
  onResizeStart,
  onSyncBrowserBounds,
  onToggleRightPanel,
  open,
  project,
  rightPanelRef,
  rightPanelTransition,
  rightPanelView,
  width,
  widthRef,
}: WorkspaceRightPanelProps) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const clampWidth = useCallback(
    (value: number) =>
      Math.max(BROWSER_PANEL_MIN_WIDTH_PX, Math.min(maxWidth, value)),
    [maxWidth],
  );

  const resizePanel = useCallback(
    (nextWidth: number) => {
      const clampedWidth = clampWidth(nextWidth);
      widthRef.current = clampedWidth;

      const panel = rightPanelRef.current;
      if (panel) {
        panel.style.width = `${clampedWidth}px`;
        panel.style.maxWidth = `${maxWidth}px`;
      }

      const wrapper = wrapperRef.current;
      if (wrapper) {
        wrapper.style.width = `${
          clampedWidth + (handleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0)
        }px`;
      }

      const track = trackRef.current;
      if (track) {
        track.style.width = `${
          clampedWidth + (handleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0)
        }px`;
      }
    },
    [clampWidth, handleVisible, maxWidth, rightPanelRef, widthRef],
  );

  const handleResizeStart = useCallback(() => {
    onResizeStart();
    widthRef.current = clampWidth(
      rightPanelRef.current?.getBoundingClientRect().width ?? widthRef.current,
    );

    if (wrapperRef.current) {
      wrapperRef.current.style.transition = "none";
    }

    if (trackRef.current) {
      trackRef.current.style.transition = "none";
    }
  }, [clampWidth, onResizeStart, rightPanelRef, widthRef]);

  const handleResize = useCallback(
    (deltaX: number) => {
      resizePanel(widthRef.current + deltaX);
    },
    [resizePanel, widthRef],
  );

  const handleResizeEnd = useCallback(() => {
    if (wrapperRef.current) {
      wrapperRef.current.style.transition = rightPanelTransition;
    }

    if (trackRef.current) {
      trackRef.current.style.transition = rightPanelTransition;
    }

    onResizeEnd(widthRef.current);
  }, [onResizeEnd, rightPanelTransition, widthRef]);

  const panelWidth = clampWidth(width);
  const handleWidth = handleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0;
  const slotWidth = panelWidth + handleWidth;

  useEffect(() => {
    widthRef.current = panelWidth;
  }, [panelWidth, widthRef]);

  return (
    <div
      aria-hidden={!open}
      className="relative z-10 h-full shrink-0 overflow-visible"
      data-right-panel-slot
      inert={!open}
      ref={wrapperRef}
      style={{
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        transition: rightPanelTransition,
        width: open ? slotWidth : 0,
        willChange: "width, opacity",
      }}
    >
      <div
        className="absolute top-0 right-0 bottom-0 flex"
        data-right-panel-track
        ref={trackRef}
        style={{
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: rightPanelTransition,
          width: slotWidth,
          willChange: "transform",
        }}
      >
        {handleVisible ? (
          <PanelResizeHandle
            onDoubleClick={onToggleRightPanel}
            onResize={handleResize}
            onResizeEnd={handleResizeEnd}
            onResizeStart={handleResizeStart}
            side="left"
          />
        ) : null}
        <div
          className={cn(
            "shrink-0 overflow-hidden",
            handleVisible ? "" : "min-w-0",
          )}
          ref={rightPanelRef}
          style={{
            boxSizing: "border-box",
            maxWidth,
            minWidth: 0,
            width: panelWidth,
          }}
        >
          <div
            className="h-full pb-2"
            style={{ minWidth: BROWSER_PANEL_MIN_WIDTH_PX }}
          >
            <BrowserPanel
              active={active}
              browserHostRef={browserHostRef}
              browserResizeHidden={browserResizeHidden}
              onSyncBrowserBounds={onSyncBrowserBounds}
              project={project}
              rightPanelView={rightPanelView}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
