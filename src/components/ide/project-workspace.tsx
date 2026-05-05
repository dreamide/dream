import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { ProjectConfig } from "@/types/ide";
import { useIdeStore } from "./ide-store";
import type { RightPanelView } from "./ide-types";

import {
  BROWSER_PANEL_DEFAULT_WIDTH_PX,
  BROWSER_PANEL_MIN_WIDTH_PX,
  CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
  CHAT_HISTORY_PANEL_MAX_WIDTH_PX,
  CHAT_PANEL_MIN_HEIGHT_PX,
  CHAT_PANEL_MIN_WIDTH_PX,
  clampChatHistoryPanelWidth,
  EMPTY_BROWSER_TABS,
  EMPTY_TERMINAL_SESSION_IDS,
  PANEL_EDGE_PADDING_PX,
  PANEL_RESIZE_HANDLE_SIZE_PX,
  PANEL_TRANSITION,
  RIGHT_PANEL_TRANSITION,
  TERMINAL_PANEL_DEFAULT_HEIGHT_PX,
  TERMINAL_PANEL_MIN_HEIGHT_PX,
  TERMINAL_PANEL_TRANSITION,
  WORKSPACE_SIDE_NAV_WIDTH_PX,
} from "./workspace";
import { WorkspaceChatStack } from "./workspace/chat-stack";
import { WorkspaceHistoryPanel } from "./workspace/history-panel";
import { WorkspaceRightPanel } from "./workspace/right-panel";
import { WorkspaceRightRail } from "./workspace/right-rail";
import { WorkspaceSideNav } from "./workspace/side-nav";
import { WorkspaceTerminalDock } from "./workspace/terminal-dock";
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
  const activeProjectTerminalPanelOpen = useIdeStore(
    (s) => s.projectTerminalPanelOpenByProject[projectId] ?? false,
  );
  const historyOpen = projectUi.chatHistoryPanelOpen;
  const setProjectPanelSizes = useIdeStore((s) => s.setProjectPanelSizes);
  const setProjectChatHistoryPanelOpen = useIdeStore(
    (s) => s.setProjectChatHistoryPanelOpen,
  );
  const setProjectRightPanelOpen = useIdeStore(
    (s) => s.setProjectRightPanelOpen,
  );
  const rightPanelView = projectUi.rightPanelView;
  const setProjectRightPanelView = useIdeStore(
    (s) => s.setProjectRightPanelView,
  );
  const addChat = useIdeStore((s) => s.addChat);
  const openProjectTerminal = useIdeStore((s) => s.openProjectTerminal);

  // ── Local workspace state ───────────────────────────────────────────
  const [historyPanelWidth, setHistoryPanelWidth] = useState(() =>
    clampChatHistoryPanelWidth(
      projectPanelSizes.chatHistoryPanelWidth ??
        CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
    ),
  );

  // ── Derived values ──────────────────────────────────────────────────
  const middleVisible = true;
  const activeBrowserTab = useActiveBrowserTab(browserTabs, activeBrowserTabId);
  const mountedChats = useMountedProjectChats({
    activeChatId,
    chats,
    projectId,
    streamingChatIds,
  });
  const hasProjectTerminalSessions = projectTerminalSessionIds.length > 0;
  const terminalPanelVisible =
    activeProjectTerminalPanelOpen && hasProjectTerminalSessions;
  const terminalHiddenWithActiveSession =
    hasProjectTerminalSessions && !activeProjectTerminalPanelOpen;
  const rightPanelTransitionEnabledRef = useRef(false);
  const terminalPanelTransitionEnabledRef = useRef(false);
  const rightPanelTransition = rightPanelTransitionEnabledRef.current
    ? RIGHT_PANEL_TRANSITION
    : "none";
  const terminalPanelTransition = terminalPanelTransitionEnabledRef.current
    ? TERMINAL_PANEL_TRANSITION
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
    historyPanelWidthRef.current = savedHistoryPanelWidth;
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
  const historyPanelWidthRef = useRef(historyPanelWidth);
  const rightWidthRef = useRef(BROWSER_PANEL_DEFAULT_WIDTH_PX);
  const terminalHeightRef = useRef(TERMINAL_PANEL_DEFAULT_HEIGHT_PX);
  const horizontalPanelsRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const middlePanelRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelWrapperRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  if (!isDraggingRef.current) {
    rightWidthRef.current = projectPanelSizes.rightPanelWidth;
    terminalHeightRef.current = projectPanelSizes.terminalHeight;
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
      historyPanelWidthRef.current = width;
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

  const handleHistoryResizeStart = useCallback(() => {
    const panel = historyPanelRef.current;
    if (!panel) {
      return;
    }

    historyPanelWidthRef.current = clampChatHistoryPanelWidth(
      panel.getBoundingClientRect().width,
    );
    panel.style.transition = "none";
  }, []);

  const handleHistoryResize = useCallback((deltaX: number) => {
    const nextWidth = clampChatHistoryPanelWidth(
      historyPanelWidthRef.current + deltaX,
    );
    historyPanelWidthRef.current = nextWidth;

    const panel = historyPanelRef.current;
    if (panel) {
      panel.style.width = `${nextWidth}px`;
      panel.style.maxWidth = `${CHAT_HISTORY_PANEL_MAX_WIDTH_PX}px`;
    }
  }, []);

  const finishHistoryResize = useCallback(() => {
    const panel = historyPanelRef.current;
    if (panel) {
      panel.style.transition = PANEL_TRANSITION;
    }

    handleHistoryResizeEnd(historyPanelWidthRef.current);
  }, [handleHistoryResizeEnd]);

  const closeHistoryPanel = useCallback(() => {
    setProjectChatHistoryPanelOpen(projectId, false);
  }, [projectId, setProjectChatHistoryPanelOpen]);

  const handleAddChat = useCallback(() => {
    addChat(projectId);
  }, [addChat, projectId]);

  const handleOpenTerminal = useCallback(() => {
    void openProjectTerminal(projectId);
  }, [openProjectTerminal, projectId]);

  const handleToggleRightPanel = useCallback(() => {
    setProjectRightPanelOpen(projectId, !rightVisible);
  }, [projectId, rightVisible, setProjectRightPanelOpen]);

  const handleSelectRightPanelView = useCallback(
    (view: RightPanelView) => {
      if (rightVisible && rightPanelView === view) {
        setProjectRightPanelOpen(projectId, false);
        return;
      }

      setProjectRightPanelView(projectId, view);
      setProjectRightPanelOpen(projectId, true);
    },
    [
      projectId,
      rightPanelView,
      rightVisible,
      setProjectRightPanelOpen,
      setProjectRightPanelView,
    ],
  );

  const handleTerminalResizeStart = useCallback(() => {
    const wrapper = terminalPanelWrapperRef.current;
    if (wrapper) {
      wrapper.style.transition = "none";
    }

    const el = terminalPanelRef.current;
    if (!el) {
      return;
    }

    el.style.transition = "none";
    terminalHeightRef.current = el.getBoundingClientRect().height;
  }, []);

  const handleTerminalResize = useCallback((deltaY: number) => {
    const containerHeight =
      middlePanelRef.current?.getBoundingClientRect().height ?? 0;
    const maxHeight = Math.max(
      TERMINAL_PANEL_MIN_HEIGHT_PX,
      containerHeight - CHAT_PANEL_MIN_HEIGHT_PX - PANEL_RESIZE_HANDLE_SIZE_PX,
    );
    const next = Math.min(
      maxHeight,
      Math.max(
        TERMINAL_PANEL_MIN_HEIGHT_PX,
        terminalHeightRef.current + deltaY,
      ),
    );

    terminalHeightRef.current = next;
    const wrapper = terminalPanelWrapperRef.current;
    if (wrapper) {
      wrapper.style.height = `${next + PANEL_RESIZE_HANDLE_SIZE_PX}px`;
    }

    const el = terminalPanelRef.current;
    if (el) {
      el.style.height = `${next}px`;
    }
  }, []);

  const handleTerminalResizeEnd = useCallback(() => {
    const wrapper = terminalPanelWrapperRef.current;
    if (wrapper) {
      wrapper.style.transition = terminalPanelTransition;
    }

    const el = terminalPanelRef.current;
    if (el) {
      el.style.transition = terminalPanelTransition;
    }

    if (!active) {
      return;
    }

    setProjectPanelSizes(projectId, (current) => ({
      ...current,
      terminalHeight: terminalHeightRef.current,
    }));
  }, [active, projectId, setProjectPanelSizes, terminalPanelTransition]);

  useEffect(() => {
    rightPanelTransitionEnabledRef.current = true;
    terminalPanelTransitionEnabledRef.current = true;
  });

  const handleRightResizeEndWithBrowserSync = useCallback(
    (width: number) => {
      handleRightResizeEnd(width);
      restoreBrowserAfterRightResize();
    },
    [handleRightResizeEnd, restoreBrowserAfterRightResize],
  );

  useEffect(() => {
    const update = () => syncHorizontalPanelWidths();
    const observer = new ResizeObserver(update);
    const host = horizontalPanelsRef.current;
    if (host) {
      observer.observe(host);
    }

    window.addEventListener("resize", update);
    const frame = window.requestAnimationFrame(update);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [syncHorizontalPanelWidths]);

  const rightPanelMaxWidth = getRightPanelMaxWidth();
  const boundedRightPanelMaxWidth = Number.isFinite(rightPanelMaxWidth)
    ? rightPanelMaxWidth
    : Number.MAX_SAFE_INTEGER;

  return (
    <div className="relative flex h-full" ref={horizontalPanelsRef}>
      <WorkspaceSideNav
        historyButtonRef={historyButtonRef}
        historyOpen={historyOpen}
        onAddChat={handleAddChat}
        onToggleHistory={() =>
          setProjectChatHistoryPanelOpen(projectId, !historyOpen)
        }
      />

      <WorkspaceHistoryPanel
        active={active}
        historyOpen={historyOpen}
        historyPanelRef={historyPanelRef}
        historyPanelWidth={historyPanelWidth}
        onChatSelect={closeHistoryPanel}
        onResize={handleHistoryResize}
        onResizeEnd={finishHistoryResize}
        onResizeStart={handleHistoryResizeStart}
        project={project}
      />

      {/* ─── MIDDLE: Chat + Terminal ─── */}
      <div
        className="min-w-0 flex-1"
        style={{
          minWidth: middleVisible ? CHAT_PANEL_MIN_WIDTH_PX : 0,
          display: middleVisible ? undefined : "none",
        }}
      >
        <div
          ref={middlePanelRef}
          className="flex h-full w-full flex-col rounded-lg"
        >
          <WorkspaceChatStack
            active={active}
            activeChatId={activeChatId}
            mountedChats={mountedChats}
            project={project}
          />

          <WorkspaceTerminalDock
            active={active}
            hasProjectTerminalSessions={hasProjectTerminalSessions}
            onOpenTerminal={handleOpenTerminal}
            onResize={handleTerminalResize}
            onResizeEnd={handleTerminalResizeEnd}
            onResizeStart={handleTerminalResizeStart}
            projectId={projectId}
            terminalHeight={terminalHeightRef.current}
            terminalPanelRef={terminalPanelRef}
            terminalPanelTransition={terminalPanelTransition}
            terminalPanelVisible={terminalPanelVisible}
            terminalPanelWrapperRef={terminalPanelWrapperRef}
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
        hasProjectTerminalSessions={hasProjectTerminalSessions}
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
