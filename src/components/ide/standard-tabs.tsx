import { X } from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const DEFAULT_TAB_GAP = 4;
const DEFAULT_TAB_MIN_WIDTH = 144;
const DEFAULT_TAB_MAX_WIDTH = 220;
const TAB_DRAG_THRESHOLD = 4;
const TAB_FLIP_DURATION_MS = 180;

export type StandardTabItem = {
  id: string;
  label: string;
  leading?: ReactNode;
};

type DragState = {
  currentIndex: number;
  currentX: number;
  initialIndex: number;
  moved: boolean;
  pointerId: number;
  startX: number;
  tabId: string;
};

type StandardTabsProps<TItem extends StandardTabItem> = {
  activeId: string | null;
  after?: ReactNode;
  ariaLabel?: string;
  canClose?: boolean | ((item: TItem) => boolean);
  className?: string;
  closeAriaLabel?: (item: TItem) => string;
  gap?: number;
  interactiveClassName?: string;
  items: TItem[];
  maxWidth?: number;
  minWidth?: number;
  onActivate: (id: string) => void;
  onClose?: (id: string) => void;
  onRename?: (id: string, label: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  renameOnDoubleClick?: boolean;
  renderActions?: (item: TItem) => ReactNode;
  renderFrame?: (
    item: TItem,
    tab: ReactNode,
    state: { isActive: boolean; isDragging: boolean },
  ) => ReactNode;
  tabClassName?: string;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const resolveCanClose = <TItem extends StandardTabItem>(
  canClose: StandardTabsProps<TItem>["canClose"],
  item: TItem,
) => {
  if (typeof canClose === "function") {
    return canClose(item);
  }

  return canClose ?? false;
};

export const moveTabItem = <TItem,>(
  items: TItem[],
  fromIndex: number,
  toIndex: number,
) => {
  if (fromIndex === toIndex) {
    return items;
  }

  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return items;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
};

export const StandardTabs = <TItem extends StandardTabItem>({
  activeId,
  after,
  ariaLabel,
  canClose = false,
  className,
  closeAriaLabel,
  gap = DEFAULT_TAB_GAP,
  interactiveClassName,
  items,
  maxWidth = DEFAULT_TAB_MAX_WIDTH,
  minWidth = DEFAULT_TAB_MIN_WIDTH,
  onActivate,
  onClose,
  onRename,
  onReorder,
  renameOnDoubleClick = false,
  renderActions,
  renderFrame,
  tabClassName,
}: StandardTabsProps<TItem>) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const afterRef = useRef<HTMLDivElement | null>(null);
  const dragTabRef = useRef<DragState | null>(null);
  const settlingCleanupTimeoutRef = useRef<number | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [dragTab, setDragTab] = useState<DragState | null>(null);
  const [tabWidth, setTabWidth] = useState(maxWidth);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState("");
  const [settlingTabIds, setSettlingTabIds] = useState<string[]>([]);
  const lastTab = items.at(-1) ?? null;
  const showAfterSplitter = Boolean(lastTab && lastTab.id !== activeId);

  const dragStep = tabWidth + gap;
  const resolveDragDistance = useCallback(
    (state: DragState) =>
      clamp(
        state.currentX - state.startX,
        -state.initialIndex * dragStep,
        (items.length - 1 - state.initialIndex) * dragStep,
      ),
    [dragStep, items.length],
  );
  const resolveTabOffset = useCallback(
    (state: DragState, tabId: string, tabIndex: number) => {
      if (!state.moved) {
        return 0;
      }

      if (tabId === state.tabId) {
        return resolveDragDistance(state);
      }

      if (
        state.initialIndex < state.currentIndex &&
        tabIndex > state.initialIndex &&
        tabIndex <= state.currentIndex
      ) {
        return -dragStep;
      }

      if (
        state.initialIndex > state.currentIndex &&
        tabIndex >= state.currentIndex &&
        tabIndex < state.initialIndex
      ) {
        return dragStep;
      }

      return 0;
    },
    [dragStep, resolveDragDistance],
  );
  const getDragAffectedTabIds = useCallback(
    (state: DragState) => {
      const startIndex = Math.min(state.initialIndex, state.currentIndex);
      const endIndex = Math.max(state.initialIndex, state.currentIndex);

      return items.slice(startIndex, endIndex + 1).map((item) => item.id);
    },
    [items],
  );

  const measureTabWidth = useCallback(() => {
    const containerWidth = containerRef.current?.clientWidth ?? 0;
    const afterWidth = afterRef.current?.offsetWidth ?? 0;

    if (!items.length || !containerWidth) {
      setTabWidth(maxWidth);
      return;
    }

    const availableWidth = containerWidth - afterWidth - gap * items.length;
    const nextWidth = clamp(availableWidth / items.length, minWidth, maxWidth);

    setTabWidth(nextWidth);
  }, [gap, items.length, maxWidth, minWidth]);

  useEffect(() => {
    measureTabWidth();

    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(() => {
      measureTabWidth();
    });

    observer.observe(container);
    if (afterRef.current) {
      observer.observe(afterRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, [measureTabWidth]);

  useEffect(() => {
    if (editingTabId && !items.some((item) => item.id === editingTabId)) {
      setEditingTabId(null);
      setEditingLabel("");
    }
  }, [editingTabId, items]);

  useEffect(
    () => () => {
      if (settlingCleanupTimeoutRef.current !== null) {
        window.clearTimeout(settlingCleanupTimeoutRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (settlingTabIds.length === 0) {
      return;
    }

    if (settlingCleanupTimeoutRef.current !== null) {
      window.clearTimeout(settlingCleanupTimeoutRef.current);
    }

    settlingCleanupTimeoutRef.current = window.setTimeout(() => {
      setSettlingTabIds([]);
      settlingCleanupTimeoutRef.current = null;
    }, TAB_FLIP_DURATION_MS);
  }, [settlingTabIds.length]);

  const commitRename = useCallback(
    (tabId: string) => {
      const nextLabel = editingLabel.trim();
      if (nextLabel) {
        onRename?.(tabId, nextLabel);
      }

      setEditingTabId(null);
      setEditingLabel("");
    },
    [editingLabel, onRename],
  );

  const finishDrag = useCallback(
    (
      tabId: string,
      pointerId: number,
      shouldCommit: boolean,
      currentTarget: HTMLButtonElement,
    ) => {
      const committedDragTab = dragTabRef.current;
      if (
        committedDragTab &&
        committedDragTab.tabId === tabId &&
        committedDragTab.pointerId === pointerId
      ) {
        const shouldReorder =
          shouldCommit &&
          committedDragTab.moved &&
          committedDragTab.initialIndex !== committedDragTab.currentIndex;

        if (committedDragTab.moved) {
          suppressClickRef.current = committedDragTab.tabId;
        }

        if (shouldReorder) {
          const settlingIds = getDragAffectedTabIds(committedDragTab);
          dragTabRef.current = null;
          flushSync(() => {
            setDragTab(null);
            setSettlingTabIds(settlingIds);
            onReorder?.(
              committedDragTab.initialIndex,
              committedDragTab.currentIndex,
            );
          });
          if (currentTarget.hasPointerCapture(pointerId)) {
            currentTarget.releasePointerCapture(pointerId);
          }
          return;
        }

        dragTabRef.current = null;
        setDragTab(null);
        if (currentTarget.hasPointerCapture(pointerId)) {
          currentTarget.releasePointerCapture(pointerId);
        }
        return;
      }

      if (currentTarget.hasPointerCapture(pointerId)) {
        currentTarget.releasePointerCapture(pointerId);
      }
    },
    [getDragAffectedTabIds, onReorder],
  );

  const handlePointerDown = useCallback(
    (
      event: PointerEvent<HTMLButtonElement>,
      tabId: string,
      tabIndex: number,
    ) => {
      if (event.button !== 0 || !onReorder || editingTabId === tabId) {
        return;
      }

      event.preventDefault();
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      const nextDragTab = {
        currentIndex: tabIndex,
        currentX: event.clientX,
        initialIndex: tabIndex,
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        tabId,
      };
      dragTabRef.current = nextDragTab;
      setDragTab(nextDragTab);
    },
    [editingTabId, onReorder],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>, tabId: string) => {
      const currentDragTab = dragTabRef.current;
      if (
        currentDragTab &&
        currentDragTab.tabId === tabId &&
        currentDragTab.pointerId === event.pointerId
      ) {
        const dragOffset = event.clientX - currentDragTab.startX;
        const moved =
          currentDragTab.moved || Math.abs(dragOffset) >= TAB_DRAG_THRESHOLD;
        const nextIndex = moved
          ? clamp(
              Math.round(
                (currentDragTab.initialIndex * dragStep + dragOffset) /
                  dragStep,
              ),
              0,
              items.length - 1,
            )
          : currentDragTab.initialIndex;

        if (
          currentDragTab.currentX === event.clientX &&
          currentDragTab.currentIndex === nextIndex &&
          currentDragTab.moved === moved
        ) {
          return;
        }

        const nextDragTab = {
          ...currentDragTab,
          currentIndex: nextIndex,
          currentX: event.clientX,
          moved,
        };
        dragTabRef.current = nextDragTab;
        setDragTab(nextDragTab);
        return;
      }

      setDragTab((currentDragTabFromState) => {
        if (
          !currentDragTabFromState ||
          currentDragTabFromState.tabId !== tabId ||
          currentDragTabFromState.pointerId !== event.pointerId
        ) {
          return currentDragTabFromState;
        }

        const dragOffset = event.clientX - currentDragTabFromState.startX;
        const moved =
          currentDragTabFromState.moved ||
          Math.abs(dragOffset) >= TAB_DRAG_THRESHOLD;
        const nextIndex = moved
          ? clamp(
              Math.round(
                (currentDragTabFromState.initialIndex * dragStep + dragOffset) /
                  dragStep,
              ),
              0,
              items.length - 1,
            )
          : currentDragTabFromState.initialIndex;

        if (
          currentDragTabFromState.currentX === event.clientX &&
          currentDragTabFromState.currentIndex === nextIndex &&
          currentDragTabFromState.moved === moved
        ) {
          return currentDragTabFromState;
        }

        const nextDragTab = {
          ...currentDragTabFromState,
          currentIndex: nextIndex,
          currentX: event.clientX,
          moved,
        };
        dragTabRef.current = nextDragTab;
        return nextDragTab;
      });
    },
    [dragStep, items.length],
  );

  const getTabOffset = useCallback(
    (tabId: string, tabIndex: number) =>
      dragTab ? resolveTabOffset(dragTab, tabId, tabIndex) : 0,
    [dragTab, resolveTabOffset],
  );

  return (
    <div
      aria-label={ariaLabel}
      className={cn("flex min-w-0 max-w-full items-end gap-1", className)}
      ref={containerRef}
      role="tablist"
    >
      <div
        className={cn("min-w-0 overflow-hidden pb-px", interactiveClassName)}
      >
        <div className="flex min-w-0 items-end gap-1">
          {items.map((item, tabIndex) => {
            const isActive = item.id === activeId;
            const nextItem = items[tabIndex + 1] ?? null;
            const isDragging = item.id === dragTab?.tabId && dragTab.moved;
            const tabOffset = getTabOffset(item.id, tabIndex);
            const isRepositioning =
              Boolean(dragTab?.moved) && (isDragging || tabOffset !== 0);
            const showClose = onClose && resolveCanClose(canClose, item);
            const actions = renderActions?.(item);
            const hasRightAdornment = showClose || Boolean(actions);
            const showTrailingSplitter =
              !isActive && nextItem !== null && nextItem.id !== activeId;
            const isEditing = editingTabId === item.id;
            const tabStyle: CSSProperties = {
              transform: `translateX(${tabOffset}px)`,
              width: `${tabWidth}px`,
              zIndex: isDragging ? 10 : 0,
            };
            const tabClasses = cn(
              "flex h-8 w-full select-none items-center gap-2 rounded-lg border px-3 text-sm opacity-100 transition-colors",
              hasRightAdornment && "pr-8",
              isActive
                ? "border-border bg-background text-foreground dark:bg-[oklch(0.30_0_0)]"
                : "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground group-hover:bg-muted group-hover:text-foreground",
              tabClassName,
            );
            const tabButton = isEditing ? (
              <div
                aria-selected={isActive}
                className={tabClasses}
                role="tab"
                tabIndex={-1}
              >
                {item.leading}
                <Input
                  autoFocus
                  className="h-6 min-w-0 flex-1 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                  onBlur={() => commitRename(item.id)}
                  onChange={(event) =>
                    setEditingLabel(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitRename(item.id);
                    }

                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingTabId(null);
                      setEditingLabel("");
                    }
                  }}
                  value={editingLabel}
                />
              </div>
            ) : (
              <button
                aria-selected={isActive}
                className={tabClasses}
                draggable={false}
                onClick={() => {
                  if (suppressClickRef.current === item.id) {
                    suppressClickRef.current = null;
                    return;
                  }

                  if (editingTabId !== item.id) {
                    onActivate(item.id);
                  }
                }}
                onDoubleClick={(event) => {
                  if (!renameOnDoubleClick || !onRename) {
                    return;
                  }

                  event.preventDefault();
                  setEditingTabId(item.id);
                  setEditingLabel(item.label);
                }}
                onDragStart={(event) => {
                  event.preventDefault();
                }}
                onLostPointerCapture={(event) =>
                  finishDrag(
                    item.id,
                    event.pointerId,
                    true,
                    event.currentTarget,
                  )
                }
                onPointerCancel={(event) =>
                  finishDrag(
                    item.id,
                    event.pointerId,
                    false,
                    event.currentTarget,
                  )
                }
                onPointerDown={(event) =>
                  handlePointerDown(event, item.id, tabIndex)
                }
                onPointerMove={(event) => handlePointerMove(event, item.id)}
                onPointerUp={(event) =>
                  finishDrag(
                    item.id,
                    event.pointerId,
                    true,
                    event.currentTarget,
                  )
                }
                role="tab"
                type="button"
              >
                {item.leading}
                <span className="min-w-0 truncate">{item.label}</span>
              </button>
            );

            return (
              <div
                className={cn(
                  "group relative shrink-0 overflow-visible",
                  isRepositioning || settlingTabIds.includes(item.id)
                    ? "transition-none"
                    : "transition-transform duration-150 ease-out",
                )}
                key={item.id}
                ref={(element) => {
                  if (element) {
                    tabRefs.current.set(item.id, element);
                    return;
                  }

                  tabRefs.current.delete(item.id);
                }}
                style={tabStyle}
              >
                {renderFrame
                  ? renderFrame(item, tabButton, { isActive, isDragging })
                  : tabButton}
                {showTrailingSplitter ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 right-[-2.5px] h-4 w-px -translate-y-1/2 bg-foreground/20"
                  />
                ) : null}
                {actions ? actions : null}
                {showClose ? (
                  <button
                    aria-label={closeAriaLabel?.(item) ?? `Close ${item.label}`}
                    className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-colors hover:bg-accent hover:text-accent-foreground group-hover:opacity-100"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onClose(item.id);
                    }}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    type="button"
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      {after ? (
        <div
          className={cn(
            "flex shrink-0 items-center gap-1",
            interactiveClassName,
          )}
          ref={afterRef}
        >
          <div
            aria-hidden="true"
            className={cn(
              "h-4 w-px bg-foreground/20",
              !showAfterSplitter && "opacity-0",
            )}
          />
          {after}
        </div>
      ) : null}
    </div>
  );
};
