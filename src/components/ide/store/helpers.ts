import type { UIMessage } from "ai";
import type { BrowserTabState, ProjectConfig } from "@/types/ide";

const areMessagePartsEqual = (
  left: UIMessage["parts"][number],
  right: UIMessage["parts"][number],
) => {
  if (left === right) {
    return true;
  }

  if (left.type !== right.type) {
    return false;
  }

  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

export const areMessagesEqual = (
  left: UIMessage[] | undefined,
  right: UIMessage[],
): boolean => {
  if (left === right) {
    return true;
  }

  if (!left || left.length !== right.length) {
    return false;
  }

  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    if (l === r) continue;
    if (l.id !== r.id || l.role !== r.role) return false;
    if (l.parts.length !== r.parts.length) return false;

    for (let partIndex = 0; partIndex < l.parts.length; partIndex++) {
      if (!areMessagePartsEqual(l.parts[partIndex], r.parts[partIndex])) {
        return false;
      }
    }
  }

  return true;
};

export const isGrowingTextualPart = (
  left: UIMessage["parts"][number],
  right: UIMessage["parts"][number],
) => {
  if (
    (left.type !== "text" && left.type !== "reasoning") ||
    left.type !== right.type
  ) {
    return false;
  }

  const previousText = "text" in left ? left.text : "";
  const nextText = "text" in right ? right.text : "";

  return (
    typeof previousText === "string" &&
    typeof nextText === "string" &&
    nextText.startsWith(previousText)
  );
};

export const shouldTouchChatUpdatedAt = (
  previousMessages: UIMessage[] | undefined,
  nextMessages: UIMessage[],
) => {
  if (!previousMessages || previousMessages.length !== nextMessages.length) {
    return true;
  }

  const lastMessageIndex = nextMessages.length - 1;

  for (
    let messageIndex = 0;
    messageIndex < nextMessages.length;
    messageIndex++
  ) {
    const previousMessage = previousMessages[messageIndex];
    const nextMessage = nextMessages[messageIndex];

    if (previousMessage === nextMessage) {
      continue;
    }

    if (
      previousMessage.id !== nextMessage.id ||
      previousMessage.role !== nextMessage.role ||
      previousMessage.parts.length !== nextMessage.parts.length
    ) {
      return true;
    }

    if (previousMessage.parts === nextMessage.parts) {
      continue;
    }

    const lastPartIndex = nextMessage.parts.length - 1;

    for (let partIndex = 0; partIndex < nextMessage.parts.length; partIndex++) {
      const previousPart = previousMessage.parts[partIndex];
      const nextPart = nextMessage.parts[partIndex];

      if (previousPart === nextPart) {
        continue;
      }

      if (
        messageIndex === lastMessageIndex &&
        partIndex === lastPartIndex &&
        isGrowingTextualPart(previousPart, nextPart)
      ) {
        continue;
      }

      return true;
    }
  }

  return false;
};

export const BROWSER_TAB_ID_PREFIX = "browser-tab";

export const createBrowserTabId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return `${BROWSER_TAB_ID_PREFIX}-${crypto.randomUUID()}`;
  }

  return `${BROWSER_TAB_ID_PREFIX}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

export const getBrowserTabTitle = (url: string) => {
  const trimmed = typeof url === "string" ? url.trim() : "";
  if (!trimmed) {
    return "New Tab";
  }

  try {
    return new URL(trimmed).hostname || "New Tab";
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").split("/")[0] || "New Tab";
  }
};

export const createBrowserTabState = (url = ""): BrowserTabState => ({
  canGoBack: false,
  canGoForward: false,
  id: createBrowserTabId(),
  title: getBrowserTabTitle(url),
  url,
});

export const getBrowserTabsForProject = (
  browserTabsByProject: Record<string, BrowserTabState[]>,
  projectId: string | null | undefined,
) => {
  if (!projectId) {
    return [];
  }

  return browserTabsByProject[projectId] ?? [];
};

export const resolveActiveBrowserTab = (
  tabs: BrowserTabState[],
  activeTabId: string | null | undefined,
) => {
  if (tabs.length === 0) {
    return null;
  }

  if (activeTabId) {
    const activeTab = tabs.find((tab) => tab.id === activeTabId);
    if (activeTab) {
      return activeTab;
    }
  }

  return tabs[0] ?? null;
};

export const getDefaultTerminalSessionName = (ordinal: number) =>
  `Terminal ${ordinal}`;

export const getTerminalOrdinalFromName = (name: string) => {
  const match = /^Terminal (\d+)$/.exec(name.trim());
  if (!match) {
    return null;
  }

  const ordinal = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(ordinal) ? ordinal : null;
};

export const moveItem = <T>(items: T[], fromIndex: number, toIndex: number) => {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length
  ) {
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

export const updateProjectInList = (
  projects: ProjectConfig[],
  projectId: string,
  updater: (project: ProjectConfig) => ProjectConfig,
) =>
  projects.map((project) =>
    project.id === projectId ? updater(project) : project,
  );

export const updateProjectUiInList = (
  projects: ProjectConfig[],
  projectId: string,
  updater: (project: ProjectConfig) => ProjectConfig["ui"],
) =>
  updateProjectInList(projects, projectId, (project) => ({
    ...project,
    ui: updater(project),
  }));
