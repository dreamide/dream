import {
  Code,
  Files,
  Globe,
  History,
  MessageSquarePlus,
  Settings,
  TerminalSquare,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { getDesktopApi } from "@/lib/electron";
import { DEFAULT_PANEL_SIZES } from "@/lib/ide-defaults";
import {
  isModalBrowserHidden,
  useModalBrowserHidden,
} from "@/lib/modal-visibility";
import { cn } from "@/lib/utils";
import type {
  BrowserBounds,
  BrowserTabState,
  ProjectConfig,
} from "@/types/ide";
import { BrowserPanel } from "./browser-panel";
import { ChatPanel } from "./chat-panel";
import {
  AppShellPlaceholder,
  HorizontalResizablePanel,
  PanelResizeHandle,
  ToggleButton,
} from "./ide-helpers";
import { useIdeStore } from "./ide-store";
import { type RightPanelView, TERMINAL_MIN_HEIGHT_PX } from "./ide-types";
import { ProjectSidebar } from "./projects-panel";
import { ProjectTerminalTabsPanel } from "./terminal-panel";

const CHAT_PANEL_MIN_WIDTH_PX = 400;
const BROWSER_PANEL_DEFAULT_WIDTH_PX = DEFAULT_PANEL_SIZES.rightPanelWidth;
const BROWSER_PANEL_MIN_WIDTH_PX = 320;
const CHAT_PANEL_MIN_HEIGHT_PX = 180;
const TERMINAL_PANEL_DEFAULT_HEIGHT_PX = DEFAULT_PANEL_SIZES.terminalHeight;
const TERMINAL_PANEL_MIN_HEIGHT_PX = TERMINAL_MIN_HEIGHT_PX + 16;
const PANEL_RESIZE_HANDLE_SIZE_PX = 1;
const PANEL_EDGE_PADDING_PX = 8;
const WORKSPACE_SIDE_NAV_WIDTH_PX = 48;
const EMPTY_TERMINAL_SESSION_IDS: string[] = [];
const EMPTY_BROWSER_TABS: BrowserTabState[] = [];
const CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX = 400;
const CHAT_HISTORY_PANEL_MAX_WIDTH_PX = 500;
const CHAT_HISTORY_PANEL_MIN_WIDTH_PX = 200;

/** Duration (ms) for panel slide animations. */
const PANEL_TRANSITION_MS = 200;
const PANEL_TRANSITION = `width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), min-width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), max-width ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), padding ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
const RIGHT_PANEL_TRANSITION = `${PANEL_TRANSITION}, flex-basis ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), flex-grow ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), flex-shrink ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
const TERMINAL_PANEL_TRANSITION = `height ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), min-height ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${PANEL_TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1)`;
const CHAT_KEEP_ALIVE_LIMIT = 10;

const clampChatHistoryPanelWidth = (width: number) =>
  Math.max(
    CHAT_HISTORY_PANEL_MIN_WIDTH_PX,
    Math.min(CHAT_HISTORY_PANEL_MAX_WIDTH_PX, width),
  );

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
  const setSettingsOpen = useIdeStore((s) => s.setSettingsOpen);
  const setSettingsSection = useIdeStore((s) => s.setSettingsSection);

  // ── Local workspace state ───────────────────────────────────────────
  const [recentMountedChatIds, setRecentMountedChatIds] = useState<string[]>(
    [],
  );
  const [historyPanelWidth, setHistoryPanelWidth] = useState(() =>
    clampChatHistoryPanelWidth(
      projectPanelSizes.chatHistoryPanelWidth ??
        CHAT_HISTORY_PANEL_DEFAULT_WIDTH_PX,
    ),
  );
  const modalBrowserHidden = useModalBrowserHidden();

  // ── Derived values ──────────────────────────────────────────────────
  const middleVisible = true;
  const activeBrowserTab = useMemo(() => {
    if (browserTabs.length === 0) {
      return null;
    }

    if (activeBrowserTabId) {
      const activeTab = browserTabs.find(
        (tab) => tab.id === activeBrowserTabId,
      );
      if (activeTab) {
        return activeTab;
      }
    }

    return browserTabs[0] ?? null;
  }, [activeBrowserTabId, browserTabs]);
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
    if (!activeChatId) {
      return;
    }

    setRecentMountedChatIds((current) => [
      activeChatId,
      ...current
        .filter((chatId) => chatId !== activeChatId)
        .slice(0, CHAT_KEEP_ALIVE_LIMIT - 1),
    ]);
  }, [activeChatId]);

  const mountedChats = useMemo(() => {
    const mountedChatIds = new Set<string>();
    const projectChats = chats.filter(
      (chat) => chat.projectId === projectId && chat.deletedAt === null,
    );
    const nextChats = [] as typeof chats;

    if (activeChatId) {
      const activeMountedChat = projectChats.find(
        (chat) => chat.id === activeChatId,
      );
      if (activeMountedChat) {
        mountedChatIds.add(activeMountedChat.id);
        nextChats.push(activeMountedChat);
      }
    }

    // Keep streaming chats mounted even when they are not recently viewed.
    for (const chat of projectChats) {
      if (!streamingChatIds[chat.id] || mountedChatIds.has(chat.id)) {
        continue;
      }

      mountedChatIds.add(chat.id);
      nextChats.push(chat);
    }

    for (const chatId of recentMountedChatIds) {
      if (
        mountedChatIds.size >= CHAT_KEEP_ALIVE_LIMIT ||
        mountedChatIds.has(chatId)
      ) {
        continue;
      }

      const recentChat = projectChats.find((chat) => chat.id === chatId);
      if (!recentChat) {
        continue;
      }

      mountedChatIds.add(recentChat.id);
      nextChats.push(recentChat);
    }

    return nextChats;
  }, [activeChatId, chats, projectId, recentMountedChatIds, streamingChatIds]);

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
          target.closest('[data-slot="dialog-content"]'))
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

  const handleOpenSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, [setSettingsOpen, setSettingsSection]);

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

  // Browser bounds sync
  const lastSentBrowserUrlRef = useRef<string | null>(null);
  const lastSentBrowserTabIdRef = useRef<string | null>(null);
  const syncBrowserBounds = useCallback(
    (reload = false) => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) return;

      if (!active) {
        return;
      }

      if (
        !activeBrowserTab?.url ||
        !rightVisible ||
        rightPanelView !== "browser" ||
        isModalBrowserHidden()
      ) {
        lastSentBrowserUrlRef.current = null;
        lastSentBrowserTabIdRef.current = null;
        desktopApi.updateBrowser({
          projectId,
          tabId: activeBrowserTab?.id,
          visible: false,
        });
        return;
      }

      const host = browserHostRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        desktopApi.updateBrowser({
          projectId,
          tabId: activeBrowserTab.id,
          visible: false,
        });
        return;
      }

      const bounds: BrowserBounds = {
        height: rect.height,
        width: rect.width,
        x: rect.x,
        y: rect.y,
      };

      const urlChanged = activeBrowserTab.url !== lastSentBrowserUrlRef.current;
      const tabChanged =
        activeBrowserTab.id !== lastSentBrowserTabIdRef.current;
      const sendUrl = reload || urlChanged || tabChanged;
      if (sendUrl) {
        lastSentBrowserUrlRef.current = activeBrowserTab.url;
        lastSentBrowserTabIdRef.current = activeBrowserTab.id;
      }

      desktopApi.updateBrowser({
        bounds,
        projectId,
        tabId: activeBrowserTab.id,
        ...(reload ? { reload: true } : {}),
        ...(sendUrl ? { url: activeBrowserTab.url } : {}),
        visible: true,
      });
    },
    [active, activeBrowserTab, projectId, rightPanelView, rightVisible],
  );

  useEffect(() => {
    if (!active) {
      return;
    }

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    const update = () => syncBrowserBounds();
    const observer = new ResizeObserver(update);
    const host = browserHostRef.current;
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
  }, [active, syncBrowserBounds]);

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

  useEffect(() => {
    void activeBrowserTab?.id;
    void activeBrowserTab?.url;
    void modalBrowserHidden;
    syncBrowserBounds();
  }, [
    activeBrowserTab?.id,
    activeBrowserTab?.url,
    modalBrowserHidden,
    syncBrowserBounds,
  ]);

  useEffect(() => {
    return () => {
      const desktopApi = getDesktopApi();
      if (!desktopApi) return;
      const activeProjectId = useIdeStore.getState().activeProjectId;
      if (activeProjectId && activeProjectId !== projectId) {
        return;
      }

      desktopApi.updateBrowser({
        projectId,
        tabId: activeBrowserTab?.id,
        visible: false,
      });
    };
  }, [activeBrowserTab?.id, projectId]);

  const rightPanelMaxWidth = getRightPanelMaxWidth();
  const boundedRightPanelMaxWidth = Number.isFinite(rightPanelMaxWidth)
    ? rightPanelMaxWidth
    : Number.MAX_SAFE_INTEGER;

  return (
    <div className="relative flex h-full" ref={horizontalPanelsRef}>
      <aside className="flex w-12 shrink-0 flex-col items-center py-2">
        <div className="flex flex-col items-center gap-1">
          <Button
            aria-label="Chat history"
            className={cn(
              "size-8",
              historyOpen
                ? "text-foreground hover:text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() =>
              setProjectChatHistoryPanelOpen(projectId, !historyOpen)
            }
            ref={historyButtonRef}
            size="icon"
            title="Chat history"
            variant="ghost"
          >
            <History className="size-4" />
          </Button>
          <Button
            aria-label="New chat"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={handleAddChat}
            size="icon"
            title="New chat"
            variant="ghost"
          >
            <MessageSquarePlus className="size-4" />
          </Button>
        </div>

        <Button
          aria-label="Settings"
          className="mt-auto size-8 text-muted-foreground hover:text-foreground"
          onClick={handleOpenSettings}
          size="icon"
          title="Settings"
          variant="ghost"
        >
          <Settings className="size-4" />
        </Button>
      </aside>

      <div
        aria-hidden={!historyOpen}
        className="absolute top-0 bottom-0 z-30 overflow-hidden"
        inert={!historyOpen}
        ref={historyPanelRef}
        style={{
          boxSizing: "border-box",
          left: WORKSPACE_SIDE_NAV_WIDTH_PX,
          maxWidth: historyOpen ? CHAT_HISTORY_PANEL_MAX_WIDTH_PX : 0,
          minWidth: historyOpen ? CHAT_HISTORY_PANEL_MIN_WIDTH_PX : 0,
          opacity: historyOpen ? 1 : 0,
          pointerEvents: historyOpen ? "auto" : "none",
          transition: PANEL_TRANSITION,
          width: historyOpen ? historyPanelWidth : 0,
          willChange: "width, opacity",
        }}
      >
        <div
          className="flex h-full"
          style={{ minWidth: CHAT_HISTORY_PANEL_MIN_WIDTH_PX }}
        >
          <div className="min-w-0 flex-1 py-2">
            {active && historyOpen ? (
              <ProjectSidebar
                className="h-full"
                onChatSelect={closeHistoryPanel}
                project={project}
              />
            ) : null}
          </div>
          {historyOpen ? (
            <PanelResizeHandle
              onDoubleClick={closeHistoryPanel}
              onResize={handleHistoryResize}
              onResizeEnd={finishHistoryResize}
              onResizeStart={handleHistoryResizeStart}
              side="right"
            />
          ) : null}
        </div>
      </div>

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
          {/* Chat area */}
          <div
            className="min-h-0 flex-1"
            style={{ minHeight: CHAT_PANEL_MIN_HEIGHT_PX }}
          >
            {mountedChats.length > 0 ? (
              mountedChats.map((chat) => {
                const isVisible = chat.id === activeChatId;

                return (
                  <div
                    aria-hidden={!isVisible}
                    inert={!isVisible}
                    key={chat.id}
                    className={
                      isVisible ? "flex h-full min-h-0 flex-col" : "hidden"
                    }
                  >
                    <ChatPanel
                      isActive={active && isVisible}
                      project={project}
                      chat={chat}
                    />
                  </div>
                );
              })
            ) : (
              <div className="h-full p-3">
                <AppShellPlaceholder message="Create a chat to start a separate conversation for this project." />
              </div>
            )}
          </div>

          {/* Terminal area */}
          <div
            ref={terminalPanelWrapperRef}
            className="shrink-0 overflow-hidden"
            style={{
              height: terminalPanelVisible
                ? terminalHeightRef.current + PANEL_RESIZE_HANDLE_SIZE_PX
                : 0,
              maxHeight: `calc(100% - ${CHAT_PANEL_MIN_HEIGHT_PX}px)`,
              opacity: terminalPanelVisible ? 1 : 0,
              pointerEvents: terminalPanelVisible ? "auto" : "none",
              transition: terminalPanelTransition,
              willChange: "height, opacity",
            }}
          >
            <PanelResizeHandle
              onDoubleClick={handleOpenTerminal}
              onResize={handleTerminalResize}
              onResizeEnd={handleTerminalResizeEnd}
              onResizeStart={handleTerminalResizeStart}
              side="top"
            />
            <div
              ref={terminalPanelRef}
              className="relative shrink-0 overflow-hidden"
              style={{
                height: terminalPanelVisible ? terminalHeightRef.current : 0,
                minHeight: terminalPanelVisible
                  ? TERMINAL_PANEL_MIN_HEIGHT_PX
                  : 0,
                maxHeight: `calc(100% - ${PANEL_RESIZE_HANDLE_SIZE_PX}px)`,
                transition: terminalPanelTransition,
                willChange: "height, opacity",
              }}
            >
              {hasProjectTerminalSessions ? (
                <div className="absolute inset-0 min-h-0">
                  <ProjectTerminalTabsPanel
                    active={active && terminalPanelVisible}
                    projectId={projectId}
                  />
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* ─── RIGHT: Browser / Explorer ─── */}
      <HorizontalResizablePanel
        className={cn(middleVisible ? "" : "min-w-0")}
        contentClassName="pb-2"
        contentMinWidth={BROWSER_PANEL_MIN_WIDTH_PX}
        handleSide="left"
        handleVisible={middleVisible}
        maxWidth={boundedRightPanelMaxWidth}
        minWidth={BROWSER_PANEL_MIN_WIDTH_PX}
        onHandleDoubleClick={handleToggleRightPanel}
        onResizeEnd={handleRightResizeEnd}
        onResizeStart={() => {
          isDraggingRef.current = true;
        }}
        open={rightVisible}
        panelRef={rightPanelRef}
        style={{
          flex: middleVisible ? undefined : rightVisible ? "1 1 0%" : "0 0 0px",
          paddingRight: 0,
          paddingLeft: rightVisible && !middleVisible ? 8 : 0,
          willChange: middleVisible
            ? "width, opacity, padding"
            : "flex-basis, opacity, padding",
        }}
        transition={rightPanelTransition}
        width={rightWidthRef.current}
        widthRef={rightWidthRef}
      >
        <BrowserPanel
          active={active}
          browserHostRef={browserHostRef}
          onSyncBrowserBounds={syncBrowserBounds}
          project={project}
          rightPanelView={rightPanelView}
        />
      </HorizontalResizablePanel>

      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 py-2">
        <ToggleButton
          active={rightVisible && rightPanelView === "changes"}
          onClick={() => handleSelectRightPanelView("changes")}
          title="Changes"
        >
          <Code className="size-4" />
        </ToggleButton>
        <ToggleButton
          active={rightVisible && rightPanelView === "explorer"}
          onClick={() => handleSelectRightPanelView("explorer")}
          title="Files"
        >
          <Files className="size-4" />
        </ToggleButton>
        <ToggleButton
          active={rightVisible && rightPanelView === "browser"}
          onClick={() => handleSelectRightPanelView("browser")}
          title="Browser"
        >
          <Globe className="size-4" />
        </ToggleButton>
        <Button
          aria-label="Open terminal"
          className={cn(
            "size-8",
            terminalHiddenWithActiveSession
              ? "text-green-600 hover:text-green-700 dark:text-green-400 dark:hover:text-green-300"
              : hasProjectTerminalSessions
                ? "text-foreground hover:text-foreground"
                : "text-muted-foreground/50 hover:text-foreground",
          )}
          onClick={handleOpenTerminal}
          size="icon"
          title="Open terminal"
          variant="ghost"
        >
          <TerminalSquare className="size-4" />
        </Button>
      </aside>
    </div>
  );
};

export const ProjectWorkspace = memo(ProjectWorkspaceComponent);
ProjectWorkspace.displayName = "ProjectWorkspace";
