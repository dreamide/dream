import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { BrowserTabState, GitPanelTab, ProjectConfig } from "@/types/ide";
import { areProjectsEqualExceptLastUsedAt } from "../ide-state";
import { useIdeStore } from "../ide-store";
import type { RightPanelView } from "../ide-types";
import { useShortcut } from "../shortcuts/shortcuts";
import {
  BROWSER_PANEL_DEFAULT_WIDTH_PX,
  BROWSER_PANEL_MIN_WIDTH_PX,
  CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
  CHAT_PANEL_MIN_WIDTH_PX,
  clampChatHistoryPanelWidth,
  EMPTY_TERMINAL_SESSION_IDS,
  PANEL_EDGE_PADDING_PX,
  PANEL_RESIZE_HANDLE_SIZE_PX,
  RESERVED_SLIDING_PANEL_TRANSITION,
  WORKSPACE_SIDE_NAV_WIDTH_PX,
} from "../workspace";
import { WorkspaceChatStack } from "../workspace/chat-stack";
import { WorkspaceHistoryPanel } from "../workspace/history-panel";
import { WorkspaceRightPanel } from "../workspace/right-panel";
import { WorkspaceRightRail } from "../workspace/right-rail";
import { WorkspaceSideNav } from "../workspace/side-nav";
import { useMountedProjectChats } from "../workspace/use-mounted-chats";

export interface CodeWorkspaceProps {
  active: boolean;
  project: ProjectConfig;
}

const EMPTY_BROWSER_TABS: BrowserTabState[] = [];

const CodeWorkspaceComponent = ({ active, project }: CodeWorkspaceProps) => {
  const projectId = project.id;
  // A phone-sized window: one chat, and every other panel as a full sheet.

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
  const chats = useIdeStore(
    useShallow((s) => s.chats.filter((chat) => chat.projectId === projectId)),
  );
  const completedChatIds = useIdeStore((s) => s.completedChatIds);
  const projectTerminalSessionIds = useIdeStore(
    (s) => s.projectTerminalSessionIds[projectId] ?? EMPTY_TERMINAL_SESSION_IDS,
  );
  const browserTabs = useIdeStore(
    (s) => s.browserTabsByProject[projectId] ?? EMPTY_BROWSER_TABS,
  );
  const activeBrowserTabId = useIdeStore(
    (s) => s.activeBrowserTabIdByProject[projectId] ?? null,
  );
  const historyOpen = projectUi.chatHistoryPanelOpen;
  const setProjectPanelSizes = useIdeStore((s) => s.setProjectPanelSizes);
  const setProjectChatHistoryPanelOpen = useIdeStore(
    (s) => s.setProjectChatHistoryPanelOpen,
  );
  const rightPanelView = projectUi.rightPanelView;
  const showRightPanelView = useIdeStore((s) => s.showRightPanelView);
  const closeRightPanel = useIdeStore((s) => s.closeRightPanel);
  const toggleRightPanel = useIdeStore((s) => s.toggleRightPanel);
  const addChat = useIdeStore((s) => s.addChat);
  const addChatBeside = useIdeStore((s) => s.addChatBeside);
  const setActiveChatId = useIdeStore((s) => s.setActiveChatId);
  const toggleProjectMultiChatMode = useIdeStore(
    (s) => s.toggleProjectMultiChatMode,
  );
  const closeChatColumn = useIdeStore((s) => s.closeChatColumn);
  const reorderChatColumns = useIdeStore((s) => s.reorderChatColumns);
  const setChatColumnWidths = useIdeStore((s) => s.setChatColumnWidths);
  const openProjectTerminal = useIdeStore((s) => s.openProjectTerminal);

  // ── Local workspace state ───────────────────────────────────────────
  const [historyPanelWidth, setHistoryPanelWidth] = useState(() =>
    clampChatHistoryPanelWidth(
      projectPanelSizes.chatHistoryPanelWidth ??
        CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
    ),
  );
  const [rightPanelExpandedRequested, setRightPanelExpandedRequested] =
    useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);

  // ── Derived values ──────────────────────────────────────────────────
  const middleVisible = true;
  const mountedChats = useMountedProjectChats({
    activeChatId,
    chats,
    openChatIds,
    projectId,
  });
  const historyHasUnseenChats = chats.some(
    (chat) =>
      chat.projectId === projectId &&
      chat.deletedAt === null &&
      Boolean(completedChatIds[chat.id]),
  );
  const hasProjectTerminalSessions = projectTerminalSessionIds.length > 0;
  const terminalPanelVisible =
    rightVisible && rightPanelView === "terminal" && hasProjectTerminalSessions;
  const terminalHiddenWithActiveSession =
    hasProjectTerminalSessions && !terminalPanelVisible;
  const stashAvailable = (projectUi.stashItems?.length ?? 0) > 0;
  const activeBrowserTab =
    browserTabs.find((tab) => tab.id === activeBrowserTabId) ??
    browserTabs[0] ??
    null;
  const browserPanelVisible = rightVisible && rightPanelView === "browser";
  // Every right-panel view can expand over the chats.
  const panelExpanded = rightPanelExpandedRequested && rightVisible;
  const browserHiddenWithActiveTab =
    Boolean(activeBrowserTab?.url) && !browserPanelVisible;
  const rightPanelTransitionEnabledRef = useRef(false);
  const rightPanelTransition = rightPanelTransitionEnabledRef.current
    ? RESERVED_SLIDING_PANEL_TRANSITION
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
  const desiredRightWidthRef = useRef(BROWSER_PANEL_DEFAULT_WIDTH_PX);
  const renderedRightWidthRef = useRef(BROWSER_PANEL_DEFAULT_WIDTH_PX);
  const horizontalPanelsRef = useRef<HTMLDivElement | null>(null);
  const chatAreaRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<HTMLDivElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyPanelRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef(false);

  if (!isDraggingRef.current) {
    desiredRightWidthRef.current = projectPanelSizes.rightPanelWidth;
  }

  const markRightPanelDragging = useCallback(() => {
    isDraggingRef.current = true;
  }, []);

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
      rightVisible && middleVisible && !panelExpanded
        ? PANEL_RESIZE_HANDLE_SIZE_PX
        : 0;
    const rightPadding =
      rightVisible && !panelExpanded ? PANEL_EDGE_PADDING_PX : 0;

    return rightHandleWidth + rightPadding;
  }, [panelExpanded, rightVisible]);

  const getRightPanelMaxWidth = useCallback(() => {
    if (!rightVisible || !middleVisible || panelExpanded) {
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
  }, [panelExpanded, getHorizontalChromeWidth, rightVisible]);

  const syncHorizontalPanelWidths = useCallback(() => {
    if (!rightVisible || !middleVisible || panelExpanded) {
      return;
    }

    const maxRightWidth = getRightPanelMaxWidth();
    const desiredRightWidth = Math.max(
      BROWSER_PANEL_MIN_WIDTH_PX,
      desiredRightWidthRef.current,
    );
    const nextRightWidth = Math.min(maxRightWidth, desiredRightWidth);
    renderedRightWidthRef.current = nextRightWidth;

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
  }, [panelExpanded, getRightPanelMaxWidth, rightVisible]);

  const handleRightResizeEnd = useCallback(
    (width: number) => {
      isDraggingRef.current = false;
      desiredRightWidthRef.current = width;
      renderedRightWidthRef.current = width;

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
      setChatColumnWidths(projectId, widths);
    },
    [projectId, setChatColumnWidths],
  );

  const handleChatReorder = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (active) {
        reorderChatColumns(projectId, fromIndex, toIndex);
      }
    },
    [active, projectId, reorderChatColumns],
  );

  const handleCloseChat = useCallback(
    (chatId: string) => {
      closeChatColumn(projectId, chatId);
    },
    [closeChatColumn, projectId],
  );

  const handleToggleHistory = useCallback(() => {
    setProjectChatHistoryPanelOpen(projectId, !historyOpen);
  }, [historyOpen, projectId, setProjectChatHistoryPanelOpen]);

  // What the right panel shows is the store's (showRightPanelView): the
  // rail, the shortcuts and the Git tabs toggle a view that is already
  // showing closed. Whether it is expanded is this workspace's.
  const handleToggleRightPanel = useCallback(() => {
    toggleRightPanel(projectId);
  }, [projectId, toggleRightPanel]);

  // Double-clicking the panel's edge gives it an equal share of the space it
  // shares with the chats: half beside one chat, one column's worth beside
  // several (the chat splitters equalize the same way).
  const handleEqualizeRightPanel = useCallback(() => {
    const chatArea = chatAreaRef.current;
    const rightPanel = rightPanelRef.current;
    if (!rightVisible || panelExpanded || !chatArea || !rightPanel) {
      return;
    }

    const mountedChatIds = new Set(mountedChats.map((chat) => chat.id));
    const chatCount = Math.max(
      1,
      openChatIds.filter((chatId) => mountedChatIds.has(chatId)).length,
    );
    const sharedWidth =
      chatArea.getBoundingClientRect().width +
      rightPanel.getBoundingClientRect().width;
    const width = Math.max(
      BROWSER_PANEL_MIN_WIDTH_PX,
      Math.min(getRightPanelMaxWidth(), sharedWidth / (chatCount + 1)),
    );

    desiredRightWidthRef.current = width;
    syncHorizontalPanelWidths();
    handleRightResizeEnd(renderedRightWidthRef.current);
  }, [
    getRightPanelMaxWidth,
    handleRightResizeEnd,
    mountedChats,
    openChatIds,
    panelExpanded,
    rightVisible,
    syncHorizontalPanelWidths,
  ]);

  const handleCloseRightPanel = useCallback(() => {
    setRightPanelExpandedRequested(false);
    closeRightPanel(projectId);
  }, [closeRightPanel, projectId]);

  const handleSelectRightPanelView = useCallback(
    (view: RightPanelView) => {
      showRightPanelView(projectId, view, { toggle: true });
    },
    [projectId, showRightPanelView],
  );

  const handleOpenTerminal = useCallback(
    () => handleSelectRightPanelView("terminal"),
    [handleSelectRightPanelView],
  );

  // Changes and the pull request are tabs of the Git panel: show the tab
  // there, or close the panel when it is what the panel already shows.
  const handleShowGitPanelTab = useCallback(
    (gitTab: GitPanelTab) => {
      showRightPanelView(projectId, "git", { gitTab, toggle: true });
    },
    [projectId, showRightPanelView],
  );

  const handleShowChanges = useCallback(
    () => handleShowGitPanelTab("changes"),
    [handleShowGitPanelTab],
  );

  const handleShowPullRequest = useCallback(
    () => handleShowGitPanelTab("pull-request"),
    [handleShowGitPanelTab],
  );

  // The Git panel on the tab it last showed, or closed when it is shown.
  const handleShowGit = useCallback(
    () => handleSelectRightPanelView("git"),
    [handleSelectRightPanelView],
  );

  // ── Keyboard shortcuts ───────────────────────────────────────────────
  // Every project's workspace stays mounted; only the visible one answers.
  const focusChatInput = useCallback(() => {
    setRightPanelExpandedRequested(false);
    setProjectChatHistoryPanelOpen(projectId, false);
    // After the panels above have closed, so the composer is on screen.
    requestAnimationFrame(() => {
      const root = horizontalPanelsRef.current;
      const column = activeChatId
        ? root?.querySelector(`[data-chat-id="${CSS.escape(activeChatId)}"]`)
        : null;
      const textarea = (column ?? root)?.querySelector<HTMLTextAreaElement>(
        'textarea[name="message"]:not(:disabled)',
      );
      if (!textarea) {
        return;
      }
      textarea.focus();
      const end = textarea.value.length;
      textarea.setSelectionRange(end, end);
    });
  }, [activeChatId, projectId, setProjectChatHistoryPanelOpen]);

  useShortcut("newChat", handleAddChat, active);
  useShortcut("focusChatInput", focusChatInput, active);
  useShortcut("toggleChatHistory", handleToggleHistory, active);
  useShortcut("toggleSideBySide", handleToggleMultiChat, active);
  useShortcut("toggleSidePanel", handleToggleRightPanel, active);
  useShortcut("toggleTerminal", handleOpenTerminal, active);
  useShortcut(
    "showFiles",
    () => handleSelectRightPanelView("explorer"),
    active,
  );
  useShortcut("showChanges", handleShowChanges, active);
  useShortcut(
    "showBrowser",
    () => handleSelectRightPanelView("browser"),
    active,
  );
  useShortcut("showGit", handleShowGit, active);
  useShortcut("showPullRequests", handleShowPullRequest, active);
  useShortcut("showStash", () => handleSelectRightPanelView("stash"), active);
  useShortcut(
    "findInFiles",
    () => useIdeStore.getState().openProjectFileSearch(projectId),
    active,
  );

  useEffect(() => {
    rightPanelTransitionEnabledRef.current = true;
  });

  useEffect(() => {
    if (!rightVisible && rightPanelExpandedRequested) {
      setRightPanelExpandedRequested(false);
    }
  }, [rightPanelExpandedRequested, rightVisible]);

  useEffect(() => {
    if (!active || !panelExpanded) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setRightPanelExpandedRequested(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [active, panelExpanded]);

  useEffect(() => {
    if (
      !active ||
      !rightVisible ||
      rightPanelView !== "terminal" ||
      hasProjectTerminalSessions
    ) {
      return;
    }

    void openProjectTerminal(projectId);
  }, [
    active,
    hasProjectTerminalSessions,
    openProjectTerminal,
    projectId,
    rightPanelView,
    rightVisible,
  ]);

  useEffect(() => {
    let rafId: number | null = null;
    const update = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const nextWidth = host?.getBoundingClientRect().width ?? 0;
        setWorkspaceWidth(nextWidth);
        syncHorizontalPanelWidths();
      });
    };
    const observer = new ResizeObserver(update);
    const host = horizontalPanelsRef.current;
    if (host) {
      setWorkspaceWidth(host.getBoundingClientRect().width);
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
  const rightPanelExpandedWidth = Math.max(
    BROWSER_PANEL_MIN_WIDTH_PX,
    workspaceWidth || renderedRightWidthRef.current,
  );

  return (
    <div
      className="relative flex h-full overflow-hidden"
      ref={horizontalPanelsRef}
    >
      <WorkspaceSideNav
        historyButtonRef={historyButtonRef}
        historyHasUnseenChats={historyHasUnseenChats}
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
        ref={chatAreaRef}
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
        panelExpanded={panelExpanded}
        handleVisible={middleVisible}
        maxWidth={
          panelExpanded ? rightPanelExpandedWidth : boundedRightPanelMaxWidth
        }
        onPanelExpandedChange={setRightPanelExpandedRequested}
        onCloseRightPanel={handleCloseRightPanel}
        onResizeEnd={handleRightResizeEnd}
        onResizeStart={markRightPanelDragging}
        onHandleDoubleClick={handleEqualizeRightPanel}
        open={rightVisible}
        project={project}
        rightPanelRef={rightPanelRef}
        rightPanelTransition={rightPanelTransition}
        rightPanelView={rightPanelView}
        width={
          panelExpanded ? rightPanelExpandedWidth : desiredRightWidthRef.current
        }
        widthRef={renderedRightWidthRef}
      />

      <WorkspaceRightRail
        active={active}
        browserHiddenWithActiveTab={browserHiddenWithActiveTab}
        onOpenTerminal={handleOpenTerminal}
        onSelectRightPanelView={handleSelectRightPanelView}
        projectId={projectId}
        projectPath={project.path}
        rightPanelView={rightPanelView}
        rightVisible={rightVisible}
        stashAvailable={stashAvailable}
        terminalHiddenWithActiveSession={terminalHiddenWithActiveSession}
      />
    </div>
  );
};

export const CodeWorkspace = memo(
  CodeWorkspaceComponent,
  (previous, next) =>
    previous.active === next.active &&
    areProjectsEqualExceptLastUsedAt(previous.project, next.project),
);
CodeWorkspace.displayName = "CodeWorkspace";
