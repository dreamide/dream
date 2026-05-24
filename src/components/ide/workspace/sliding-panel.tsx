import {
  type CSSProperties,
  type MutableRefObject,
  type PropsWithChildren,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { cn } from "@/lib/utils";
import { PanelResizeHandle } from "../ide-helpers";
import { PANEL_RESIZE_HANDLE_SIZE_PX } from "./constants";

type SlideSide = "left" | "right";

export interface WorkspaceSlidingPanelProps {
  className?: string;
  contentClassName?: string;
  contentMinWidth: number;
  contentStyle?: CSSProperties;
  handleVisible?: boolean;
  maxWidth: number;
  minWidth: number;
  onHandleDoubleClick?: () => void;
  onResize?: (width: number) => void;
  onResizeEnd?: (width: number) => void;
  onResizeStart?: () => void;
  open: boolean;
  panelRef?: RefObject<HTMLDivElement | null>;
  reserveSpace: boolean;
  side: SlideSide;
  slotRef?: RefObject<HTMLDivElement | null>;
  style?: CSSProperties;
  transition: string;
  width: number;
  widthRef: MutableRefObject<number>;
}

export const WorkspaceSlidingPanel = ({
  children,
  className,
  contentClassName,
  contentMinWidth,
  contentStyle,
  handleVisible = true,
  maxWidth,
  minWidth,
  onHandleDoubleClick,
  onResize,
  onResizeEnd,
  onResizeStart,
  open,
  panelRef,
  reserveSpace,
  side,
  slotRef,
  style,
  transition,
  width,
  widthRef,
}: PropsWithChildren<WorkspaceSlidingPanelProps>) => {
  const internalSlotRef = useRef<HTMLDivElement | null>(null);
  const internalTrackRef = useRef<HTMLDivElement | null>(null);
  const internalPanelRef = useRef<HTMLDivElement | null>(null);

  const setSlotRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalSlotRef.current = node;
      if (slotRef) {
        slotRef.current = node;
      }
    },
    [slotRef],
  );

  const setPanelRef = useCallback(
    (node: HTMLDivElement | null) => {
      internalPanelRef.current = node;
      if (panelRef) {
        panelRef.current = node;
      }
    },
    [panelRef],
  );

  const getPanel = useCallback(
    () => panelRef?.current ?? internalPanelRef.current,
    [panelRef],
  );

  const clampWidth = useCallback(
    (value: number) => Math.max(minWidth, Math.min(maxWidth, value)),
    [maxWidth, minWidth],
  );

  const handleWidth = handleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0;
  const panelWidth = clampWidth(width);
  const slotWidth = panelWidth + handleWidth;
  const closedTransform =
    side === "right" ? "translateX(100%)" : "translateX(-100%)";

  const applyWidth = useCallback(
    (nextWidth: number) => {
      const clampedWidth = clampWidth(nextWidth);
      const nextSlotWidth = clampedWidth + handleWidth;
      widthRef.current = clampedWidth;

      const panel = getPanel();
      if (panel) {
        panel.style.width = `${clampedWidth}px`;
        panel.style.maxWidth = `${maxWidth}px`;
      }

      const slot = internalSlotRef.current;
      if (slot) {
        slot.style.width = `${nextSlotWidth}px`;
      }

      const track = internalTrackRef.current;
      if (track) {
        track.style.width = `${nextSlotWidth}px`;
      }

      onResize?.(clampedWidth);
    },
    [clampWidth, getPanel, handleWidth, maxWidth, onResize, widthRef],
  );

  const handleResizeStart = useCallback(() => {
    onResizeStart?.();

    const panel = getPanel();
    widthRef.current = clampWidth(
      panel?.getBoundingClientRect().width ?? widthRef.current,
    );

    if (internalSlotRef.current) {
      internalSlotRef.current.style.transition = "none";
    }

    if (internalTrackRef.current) {
      internalTrackRef.current.style.transition = "none";
    }
  }, [clampWidth, getPanel, onResizeStart, widthRef]);

  const handleResize = useCallback(
    (deltaX: number) => {
      applyWidth(widthRef.current + deltaX);
    },
    [applyWidth, widthRef],
  );

  const handleResizeEnd = useCallback(() => {
    if (internalSlotRef.current) {
      internalSlotRef.current.style.transition = transition;
    }

    if (internalTrackRef.current) {
      internalTrackRef.current.style.transition = transition;
    }

    onResizeEnd?.(widthRef.current);
  }, [onResizeEnd, transition, widthRef]);

  useEffect(() => {
    widthRef.current = panelWidth;
  }, [panelWidth, widthRef]);

  const handle = handleVisible ? (
    <PanelResizeHandle
      onDoubleClick={onHandleDoubleClick}
      onResize={handleResize}
      onResizeEnd={handleResizeEnd}
      onResizeStart={handleResizeStart}
      side={side === "right" ? "left" : "right"}
    />
  ) : null;

  const panel = (
    <div
      className={cn("shrink-0 overflow-hidden", handleVisible ? "" : "min-w-0")}
      ref={setPanelRef}
      style={{
        boxSizing: "border-box",
        maxWidth,
        minWidth: 0,
        width: panelWidth,
      }}
    >
      <div
        className={cn("h-full", contentClassName)}
        style={{ minWidth: contentMinWidth, ...contentStyle }}
      >
        {children}
      </div>
    </div>
  );

  return (
    <div
      aria-hidden={!open}
      className={cn(
        reserveSpace
          ? "relative z-10 h-full shrink-0 overflow-visible"
          : "absolute top-0 bottom-0 overflow-visible",
        className,
      )}
      data-sliding-panel-slot
      inert={!open}
      ref={setSlotRef}
      style={{
        opacity: open ? 1 : 0,
        pointerEvents: open ? "auto" : "none",
        transition,
        width: open ? slotWidth : 0,
        willChange: "width, opacity",
        ...style,
      }}
    >
      <div
        className={cn(
          "absolute top-0 bottom-0 flex",
          side === "right" ? "right-0" : "left-0",
        )}
        data-sliding-panel-track
        ref={internalTrackRef}
        style={{
          transform: open ? "translateX(0)" : closedTransform,
          transition,
          width: slotWidth,
          willChange: "transform",
        }}
      >
        {side === "right" ? (
          <>
            {handle}
            {panel}
          </>
        ) : (
          <>
            {panel}
            {handle}
          </>
        )}
      </div>
    </div>
  );
};
