import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ProjectConfig } from "@/types/ide";
import { useIdeStore } from "./ide-store";
import type { RightPanelView } from "./ide-types";
import { moveTabItem } from "./standard-tabs";
import {
  BROWSER_PANEL_DEFAULT_WIDTH_PX,
  BROWSER_PANEL_MIN_WIDTH_PX,
  CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
  CHAT_PANEL_MIN_WIDTH_PX,
  clampChatHistoryPanelWidth,
  EMPTY_BROWSER_TABS,
  EMPTY_TERMINAL_SESSION_IDS,
  PANEL_EDGE_PADDING_PX,
  PANEL_RESIZE_HANDLE_SIZE_PX,
  SLIDING_PANEL_TRANSITION,
  WORKSPACE_SIDE_NAV_WIDTH_PX,
} from "./workspace";
import { WorkspaceChatStack } from "./workspace/chat-stack";
import { WorkspaceHistoryPanel } from "./workspace/history-panel";
import { WorkspaceRightPanel } from "./workspace/right-panel";
import { WorkspaceRightRail } from "./workspace/right-rail";
import { WorkspaceSideNav } from "./workspace/side-nav";
import {
  useActiveBrowserTab,
  useWorkspaceBrowserSync,
} from "./workspace/use-browser-sync";
import { useMountedProjectChats } from "./workspace/use-mounted-chats";

export interface ProjectWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

const ProjectWorkspaceComponent = ({
  active,
  project,
}: ProjectWorkspaceProps) => {
  const projectId = project.id;

  // ── Store selectors ─────────────────────────────────────────────────
  const projectUi = useIdeStore(
    (s) => s.projects.find((item) => item.id === projectId)?.ui ?? project.ui,
  );
  const projectPanelSizes = projectUi.panelSizes;
  const rightVisible = projectUi.rightPanelOpen;
  const activeChatId = projectUi.activeChatId;
  const openChatIds = projectUi.openChatIds;
  const chatColumnWidths = projectUi.chatColumnWidths;
  const multiChat = projectUi.multiChat;
  const chats = useIdeStore((s) => s.chats);
  const streamingChatIds = useIdeStore((s) => s.streamingChatIds);
  const browserTabs = useIdeStore(
    (s) => s.browserTabsByProject[projectId] ?? EMPTY_BROWSER_TABS,
  );
  const activeBrowserTabId = useIdeStore(
    (s) => s.activeBrowserTabIdByProject[projectId] ?? null,
  );
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds[projectId] ?? EMPTY_TERMINAL_SESSION_IDS,
  );
  const historyOpen = projectUi.chatHistoryPanelOpen;
  const setProjectPanelSizes = useIdeStore((s) => s.setProjectPanelSizes);
  const setProjectChatHistoryPanelOpen = useIdeStore(
    (s) => s.setProjectChatHistoryPanelOpen,
  );
  const setProjectRightPanelOpen = useIdeStore(
    (s) => s.setProjectRightPanelOpen,
  );
  const persistedRightPanelView = projectUi.rightPanelView;
  const setProjectRightPanelView = useIdeStore(
    (s) => s.setProjectRightPanelView,
  );
  const setProjectTerminalPanelOpen = useIdeStore(
    (s) => s.setProjectTerminalPanelOpen,
  );
  const addChat = useIdeStore((s) => s.addChat);
  const addChatBeside = useIdeStore((s) => s.addChatBeside);
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const toggleProjectMultiChatMode = useIdeStore(
    (s) => s.toggleProjectMultiChatMode,
  );
  const updateProject = useIdeStore((s) => s.updateProject);
  const openProjectTerminal = useIdeStore((s) => s.openProjectTerminal);

  // ── Local workspace state ───────────────────────────────────────────
  const [historyPanelWidth, setHistoryPanelWidth] = useState(() =>
    clampChatHistoryPanelWidth(
      projectPanelSizes.chatHistoryPanelWidth ??
        CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
    ),
  );
  const [rightPanelView, setRightPanelView] = useState<RightPanelView>(
    () => persistedRightPanelView,
  );

  // ── Derived values ──────────────────────────────────────────────────
  const middleVisible = true;
  const activeBrowserTab = useActiveBrowserTab(browserTabs, activeBrowserTabId);
  const mountedChats = useMountedProjectChats({
    activeChatId,
    chats,
    openChatIds,
    projectId,
    streamingChatIds,
  });
  const hasProjectTerminalSessions = projectTerminalSessionIds.length > 0;
  const terminalPanelVisible =
    rightVisible && rightPanelView === "terminal" && hasProjectTerminalSessions;
  const terminalHiddenWithActiveSession =
    hasProjectTerminalSessions && !terminalPanelVisible;
  const rightPanelTransitionEnabledRef = useRef(false);
  const rightPanelTransition = rightPanelTransitionEnabledRef.current
    ? SLIDING_PANEL_TRANSITION
    : "none";
  const savedHistoryPanelWidth = clampChatHistoryPanelWidth(
    projectPanelSizes.chatHistoryPanelWidth ??
      CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
  );

  useEffect(() => {
    if (!historyOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProjectChatHistoryPanelOpen(projectId, false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [historyOpen, projectId, setProjectChatHistoryPanelOpen]);

  useEffect(() => {
    setHistoryPanelWidth(savedHistoryPanelWidth);
  }, [savedHistoryPanelWidth]);

  useEffect(() => {
    if (!active || activeChatId) {
      return;
    }

    addChat(projectId);
  }, [active, activeChatId, addChat, projectId]);

  // ── Refs ─────────────────────────────────────────────────────────────
  const browserHostRef = useRef<HTMLDivElement | null>(null);
  const rightWidthRef = useRef(BROWSER_PANEL_DEFAULT_WIDTH_PX);
  const horizontalPanelsRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);
  const rightResizeBrowserSyncFrameRef = useRef<number | null>(null);
  const rightPanelViewPersistTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  if (!isDraggingRef.current) {
    rightWidthRef.current = projectPanelSizes.rightPanelWidth;
  }

  const markRightPanelDragging = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

  const {
    browserResizeHidden,
    hideBrowserForRightResize,
    restoreBrowserAfterRightResize,
    syncBrowserBounds,
  } = useWorkspaceBrowserSync({
    active,
    activeBrowserTab,
    browserHostRef,
    onResizeStart: markRightPanelDragging,
    projectId,
    rightPanelView,
    rightVisible,
  });

  useEffect(() => {
    if (!active || !historyOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (
        historyPanelRef.current?.contains(target) ||
        historyButtonRef.current?.contains(target) ||
        (target instanceof Element &&
          target.closest(
            '[data-slot="dialog-content"], [data-slot="dropdown-menu-content"]',
          ))
      ) {
        return;
      }

      setProjectChatHistoryPanelOpen(projectId, false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [active, historyOpen, projectId, setProjectChatHistoryPanelOpen]);

  useEffect(() => {
    if (!active && historyOpen) {
      setProjectChatHistoryPanelOpen(projectId, false);
    }
  }, [active, historyOpen, projectId, setProjectChatHistoryPanelOpen]);

  const getHorizontalChromeWidth = useCallback(() => {
    const rightHandleWidth =
      rightVisible && middleVisible ? PANEL_RESIZE_HANDLE_SIZE_PX : 0;
    const rightPadding = rightVisible ? PANEL_EDGE_PADDING_PX : 0;

    return rightHandleWidth + rightPadding;
  }, [rightVisible]);

  const getRightPanelMaxWidth = useCallback(() => {
    if (!rightVisible || !middleVisible) {
      return Number.POSITIVE_INFINITY;
    }

    const containerWidth =
      horizontalPanelsRef.current?.getBoundingClientRect().width ?? 0;
    const availableWidth =
      containerWidth -
      WORKSPACE_SIDE_NAV_WIDTH_PX * 2 -
      getHorizontalChromeWidth() -
      CHAT_PANEL_MIN_WIDTH_PX;

    return Math.max(BROWSER_PANEL_MIN_WIDTH_PX, availableWidth);
  }, [getHorizontalChromeWidth, rightVisible]);

  const syncHorizontalPanelWidths = useCallback(() => {
    if (!rightVisible || !middleVisible) {
      return;
    }

    const maxRightWidth = getRightPanelMaxWidth();
    const nextRightWidth = Math.min(
      maxRightWidth,
      Math.max(BROWSER_PANEL_MIN_WIDTH_PX, rightWidthRef.current),
    );
    rightWidthRef.current = nextRightWidth;

    const rightPanel = rightPanelRef.current;
    if (rightPanel) {
      rightPanel.style.width = `${nextRightWidth}px`;
      rightPanel.style.maxWidth = `${maxRightWidth}px`;

      const nextSlotWidth = nextRightWidth + PANEL_RESIZE_HANDLE_SIZE_PX;
      const rightPanelTrack = rightPanel.closest("[data-sliding-panel-track]");
      if (rightPanelTrack instanceof HTMLElement) {
        rightPanelTrack.style.width = `${nextSlotWidth}px`;
      }

      const rightPanelSlot = rightPanel.closest("[data-sliding-panel-slot]");
      if (rightPanelSlot instanceof HTMLElement) {
        rightPanelSlot.style.width = `${nextSlotWidth}px`;
      }
    }
  }, [getRightPanelMaxWidth, rightVisible]);

  const handleRightResizeEnd = useCallback(
    (width: number) => {
      isDraggingRef.current = false;
      rightWidthRef.current = width;

      if (!active) {
        return;
      }

      setProjectPanelSizes(projectId, (current) => ({
        ...current,
        rightPanelWidth: width,
      }));
    },
    [active, projectId, setProjectPanelSizes],
  );

  const handleHistoryResizeEnd = useCallback(
    (width: number) => {
      setHistoryPanelWidth(width);

      if (!active) {
        return;
      }

      setProjectPanelSizes(projectId, (current) => ({
        ...current,
        chatHistoryPanelWidth: width,
      }));
    },
    [active, projectId, setProjectPanelSizes],
  );

  const closeHistoryPanel = useCallback(() => {
    setProjectChatHistoryPanelOpen(projectId, false);
  }, [projectId, setProjectChatHistoryPanelOpen]);

  const handleAddChat = useCallback(() => {
    if (multiChat) {
      addChatBeside(projectId);
      return;
    }

    addChat(projectId);
  }, [addChat, addChatBeside, multiChat, projectId]);

  const handleToggleMultiChat = useCallback(() => {
    toggleProjectMultiChatMode(projectId);
  }, [projectId, toggleProjectMultiChatMode]);

  const handleActivateChat = useCallback(
    (chatId: string) => {
      setActiveChatId(projectId, chatId);
    },
    [projectId, setActiveChatId],
  );

  const handleChatColumnWidthsChange = useCallback(
    (widths: Record<string, number>) => {
      updateProject(projectId, (current) => ({
        ...current,
        ui: {
          ...current.ui,
          chatColumnWidths: Object.fromEntries(
            Object.entries(widths).filter(([chatId]) =>
              current.ui.openChatIds.includes(chatId),
            ),
          ),
        },
      }));
    },
    [projectId, updateProject],
  );

  const handleChatReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!active || fromIndex === toIndex) {
        return;
      }

      updateProject(projectId, (current) => ({
        ...current,
        ui: {
          ...current.ui,
          openChatIds: moveTabItem(current.ui.openChatIds, fromIndex, toIndex),
        },
      }));
    },
    [active, projectId, updateProject],
  );

  const handleCloseChat = useCallback(
    (chatId: string) => {
      updateProject(projectId, (current) => {
        const closedIndex = current.ui.openChatIds.indexOf(chatId);
        if (closedIndex === -1 || current.ui.openChatIds.length <= 1) {
          return current;
        }

        const openChatIds = current.ui.openChatIds.filter(
          (openChatId) => openChatId !== chatId,
        );
        const activeChatId =
          current.ui.activeChatId === chatId
            ? (openChatIds[closedIndex] ?? openChatIds[closedIndex - 1] ?? null)
            : current.ui.activeChatId;
        const chatColumnWidths = Object.fromEntries(
          Object.entries(current.ui.chatColumnWidths).filter(([openChatId]) =>
            openChatIds.includes(openChatId),
          ),
        );

        return {
          ...current,
          ui: {
            ...current.ui,
            activeChatId,
            openChatIds,
            chatColumnWidths,
          },
        };
      });
    },
    [projectId, updateProject],
  );

  const handleToggleHistory = useCallback(() => {
    setProjectChatHistoryPanelOpen(projectId, !historyOpen);
  }, [historyOpen, projectId, setProjectChatHistoryPanelOpen]);

  const handleToggleRightPanel = useCallback(() => {
    const nextOpen = !rightVisible;
    setProjectRightPanelOpen(projectId, nextOpen);

    if (!nextOpen && rightPanelView === "terminal") {
      setProjectTerminalPanelOpen(projectId, false);
    }
  }, [
    projectId,
    rightPanelView,
    rightVisible,
    setProjectRightPanelOpen,
    setProjectTerminalPanelOpen,
  ]);

  const schedulePersistRightPanelView = useCallback(
    (view: RightPanelView) => {
      if (rightPanelViewPersistTimerRef.current !== null) {
        clearTimeout(rightPanelViewPersistTimerRef.current);
      }

      rightPanelViewPersistTimerRef.current = setTimeout(() => {
        rightPanelViewPersistTimerRef.current = null;
        setProjectRightPanelView(projectId, view);
      }, 250);
    },
    [projectId, setProjectRightPanelView],
  );

  const handleOpenTerminal = useCallback(() => {
    if (rightVisible && rightPanelView === "terminal") {
      setProjectRightPanelOpen(projectId, false);
      setProjectTerminalPanelOpen(projectId, false);
      return;
    }

    setRightPanelView("terminal");
    schedulePersistRightPanelView("terminal");
    setProjectTerminalPanelOpen(projectId, true);

    if (!rightVisible) {
      setProjectRightPanelOpen(projectId, true);
    }

    void openProjectTerminal(projectId);
  }, [
    openProjectTerminal,
    projectId,
    rightPanelView,
    rightVisible,
    schedulePersistRightPanelView,
    setProjectRightPanelOpen,
    setProjectTerminalPanelOpen,
  ]);

  const handleSelectRightPanelView = useCallback(
    (view: RightPanelView) => {
      if (rightVisible && rightPanelView === view) {
        setProjectRightPanelOpen(projectId, false);
        if (view === "terminal") {
          setProjectTerminalPanelOpen(projectId, false);
        }
        return;
      }

      if (rightPanelView === "terminal" && view !== "terminal") {
        setProjectTerminalPanelOpen(projectId, false);
      }

      setRightPanelView(view);
      schedulePersistRightPanelView(view);

      if (!rightVisible) {
        setProjectRightPanelOpen(projectId, true);
      }
    },
    [
      projectId,
      rightPanelView,
      rightVisible,
      schedulePersistRightPanelView,
      setProjectRightPanelOpen,
      setProjectTerminalPanelOpen,
    ],
  );

  useEffect(() => {
    rightPanelTransitionEnabledRef.current = true;
  });

  useEffect(() => {
    setRightPanelView(persistedRightPanelView);
  }, [persistedRightPanelView]);

  useEffect(
    () => () => {
      if (rightPanelViewPersistTimerRef.current !== null) {
        clearTimeout(rightPanelViewPersistTimerRef.current);
      }
      if (rightResizeBrowserSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(rightResizeBrowserSyncFrameRef.current);
      }
    },
    [],
  );

  const handleRightResizeEndWithBrowserSync = useCallback(
    (width: number) => {
      if (rightResizeBrowserSyncFrameRef.current !== null) {
        window.cancelAnimationFrame(rightResizeBrowserSyncFrameRef.current);
        rightResizeBrowserSyncFrameRef.current = null;
      }
      handleRightResizeEnd(width);
      restoreBrowserAfterRightResize();
    },
    [handleRightResizeEnd, restoreBrowserAfterRightResize],
  );

  const handleRightResize = useCallback(() => {
    if (rightResizeBrowserSyncFrameRef.current !== null) {
      return;
    }

    rightResizeBrowserSyncFrameRef.current = window.requestAnimationFrame(
      () => {
        rightResizeBrowserSyncFrameRef.current = null;
        syncBrowserBounds();
      },
    );
  }, [syncBrowserBounds]);

  useEffect(() => {
    let rafId: number | null = null;
    const update = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        syncHorizontalPanelWidths();
      });
    };
    const observer = new ResizeObserver(update);
    const host = horizontalPanelsRef.current;
    if (host) {
      observer.observe(host);
    }

    window.addEventListener("resize", update);
    const frame = window.requestAnimationFrame(() =>
      syncHorizontalPanelWidths(),
    );

    return () => {
      window.cancelAnimationFrame(frame);
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [syncHorizontalPanelWidths]);

  const rightPanelMaxWidth = getRightPanelMaxWidth();
  const boundedRightPanelMaxWidth = Number.isFinite(rightPanelMaxWidth)
    ? rightPanelMaxWidth
    : Number.MAX_SAFE_INTEGER;

  return (
    <div
      className="relative flex h-full overflow-hidden"
      ref={horizontalPanelsRef}
    >
      <WorkspaceSideNav
        historyButtonRef={historyButtonRef}
        historyOpen={historyOpen}
        multiChat={multiChat}
        onAddChat={handleAddChat}
        onToggleMultiChat={handleToggleMultiChat}
        onToggleHistory={handleToggleHistory}
      />

      <WorkspaceHistoryPanel
        active={active}
        historyOpen={historyOpen}
        historyPanelRef={historyPanelRef}
        historyPanelWidth={historyPanelWidth}
        onChatSelect={closeHistoryPanel}
        onResizeEnd={handleHistoryResizeEnd}
        project={project}
      />

      {/* ─── MIDDLE: Chat ─── */}
      <div
        className="min-w-0 flex-1"
        style={{
          minWidth: middleVisible ? CHAT_PANEL_MIN_WIDTH_PX : 0,
          display: middleVisible ? undefined : "none",
        }}
      >
        <div className="flex h-full w-full flex-col rounded-lg">
          <WorkspaceChatStack
            active={active}
            activeChatId={activeChatId}
            chatColumnWidths={chatColumnWidths}
            mountedChats={mountedChats}
            onActivateChat={handleActivateChat}
            onChatColumnWidthsChange={handleChatColumnWidthsChange}
            onCloseChat={handleCloseChat}
            onChatReorder={handleChatReorder}
            openChatIds={openChatIds}
            project={project}
          />
        </div>
      </div>

      {/* ─── RIGHT: Browser / Explorer ─── */}
      <WorkspaceRightPanel
        active={active}
        browserHostRef={browserHostRef}
        browserResizeHidden={browserResizeHidden}
        handleVisible={middleVisible}
        maxWidth={boundedRightPanelMaxWidth}
        onResize={handleRightResize}
        onResizeEnd={handleRightResizeEndWithBrowserSync}
        onResizeStart={hideBrowserForRightResize}
        onSyncBrowserBounds={syncBrowserBounds}
        onToggleRightPanel={handleToggleRightPanel}
        open={rightVisible}
        project={project}
        rightPanelRef={rightPanelRef}
        rightPanelTransition={rightPanelTransition}
        rightPanelView={rightPanelView}
        width={rightWidthRef.current}
        widthRef={rightWidthRef}
      />

      <WorkspaceRightRail
        onOpenTerminal={handleOpenTerminal}
        onSelectRightPanelView={handleSelectRightPanelView}
        projectId={projectId}
        projectPath={project.path}
        rightPanelView={rightPanelView}
        rightVisible={rightVisible}
        terminalHiddenWithActiveSession={terminalHiddenWithActiveSession}
      />
    </div>
  );
};

export const ProjectWorkspace = memo(ProjectWorkspaceComponent);
ProjectWorkspace.displayName = "ProjectWorkspace";
