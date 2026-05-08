import type { RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getDesktopApi } from "@/lib/electron";
import {
  isModalBrowserHidden,
  useModalBrowserHidden,
} from "@/lib/modal-visibility";
import type {
  BrowserBounds,
  BrowserTabState,
  RightPanelView,
} from "@/types/ide";
import { useIdeStore } from "../ide-store";

export const useActiveBrowserTab = (
  browserTabs: BrowserTabState[],
  activeBrowserTabId: string | null,
) =>
  useMemo(() => {
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

export const useWorkspaceBrowserSync = ({
  active,
  activeBrowserTab,
  browserHostRef,
  onResizeStart,
  projectId,
  rightPanelView,
  rightVisible,
}: {
  active: boolean;
  activeBrowserTab: BrowserTabState | null;
  browserHostRef: RefObject<HTMLDivElement | null>;
  onResizeStart: () => void;
  projectId: string;
  rightPanelView: RightPanelView;
  rightVisible: boolean;
}) => {
  const [browserResizeHidden, setBrowserResizeHidden] = useState(false);
  const modalBrowserHidden = useModalBrowserHidden();
  const lastSentBrowserUrlRef = useRef<string | null>(null);
  const lastSentBrowserTabIdRef = useRef<string | null>(null);
  const browserResizeHiddenRef = useRef(false);
  const browserSyncStateRef = useRef({
    active,
    activeBrowserTab,
    projectId,
    rightPanelView,
    rightVisible,
  });

  useEffect(() => {
    browserSyncStateRef.current = {
      active,
      activeBrowserTab,
      projectId,
      rightPanelView,
      rightVisible,
    };
  }, [active, activeBrowserTab, projectId, rightPanelView, rightVisible]);

  const syncBrowserBounds = useCallback(
    (reload = false) => {
      const {
        active: latestActive,
        activeBrowserTab: latestActiveBrowserTab,
        projectId: latestProjectId,
        rightPanelView: latestRightPanelView,
        rightVisible: latestRightVisible,
      } = browserSyncStateRef.current;
      const desktopApi = getDesktopApi();
      if (!desktopApi) return;

      if (!latestActive) {
        return;
      }

      if (browserResizeHiddenRef.current) {
        return;
      }

      if (
        !latestActiveBrowserTab?.url ||
        !latestRightVisible ||
        latestRightPanelView !== "browser" ||
        isModalBrowserHidden()
      ) {
        lastSentBrowserUrlRef.current = null;
        lastSentBrowserTabIdRef.current = null;
        desktopApi.updateBrowser({
          projectId: latestProjectId,
          tabId: latestActiveBrowserTab?.id,
          visible: false,
        });
        return;
      }

      const host = browserHostRef.current;
      if (!host) return;

      const rect = host.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        desktopApi.updateBrowser({
          projectId: latestProjectId,
          tabId: latestActiveBrowserTab.id,
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

      const urlChanged =
        latestActiveBrowserTab.url !== lastSentBrowserUrlRef.current;
      const tabChanged =
        latestActiveBrowserTab.id !== lastSentBrowserTabIdRef.current;
      const sendUrl = reload || urlChanged || tabChanged;
      if (sendUrl) {
        lastSentBrowserUrlRef.current = latestActiveBrowserTab.url;
        lastSentBrowserTabIdRef.current = latestActiveBrowserTab.id;
      }

      desktopApi.updateBrowser({
        bounds,
        projectId: latestProjectId,
        tabId: latestActiveBrowserTab.id,
        ...(reload ? { reload: true } : {}),
        ...(sendUrl ? { url: latestActiveBrowserTab.url } : {}),
        visible: true,
      });
    },
    [browserHostRef],
  );

  const hideBrowserForRightResize = useCallback(() => {
    onResizeStart();

    if (
      !active ||
      !activeBrowserTab?.url ||
      !rightVisible ||
      rightPanelView !== "browser"
    ) {
      return;
    }

    lastSentBrowserUrlRef.current = null;
    lastSentBrowserTabIdRef.current = null;
    browserResizeHiddenRef.current = true;
    setBrowserResizeHidden(true);
    getDesktopApi()?.updateBrowser({
      projectId,
      tabId: activeBrowserTab.id,
      visible: false,
    });
  }, [
    active,
    activeBrowserTab,
    onResizeStart,
    projectId,
    rightPanelView,
    rightVisible,
  ]);

  const restoreBrowserAfterRightResize = useCallback(() => {
    window.requestAnimationFrame(() => {
      browserResizeHiddenRef.current = false;
      syncBrowserBounds();
      setBrowserResizeHidden(false);
    });
  }, [syncBrowserBounds]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const desktopApi = getDesktopApi();
    if (!desktopApi) return;

    let rafId: number | null = null;
    const update = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = null;
        syncBrowserBounds();
      });
    };
    const observer = new ResizeObserver(update);
    const host = browserHostRef.current;
    if (host) {
      observer.observe(host);
    }

    window.addEventListener("resize", update);
    const frame = window.requestAnimationFrame(() => syncBrowserBounds());

    return () => {
      window.cancelAnimationFrame(frame);
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [active, browserHostRef, syncBrowserBounds]);

  useEffect(() => {
    void activeBrowserTab?.id;
    void activeBrowserTab?.url;
    void modalBrowserHidden;
    void rightPanelView;
    void rightVisible;
    syncBrowserBounds();
  }, [
    activeBrowserTab?.id,
    activeBrowserTab?.url,
    modalBrowserHidden,
    rightPanelView,
    rightVisible,
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

  return {
    browserResizeHidden,
    hideBrowserForRightResize,
    restoreBrowserAfterRightResize,
    syncBrowserBounds,
  };
};
