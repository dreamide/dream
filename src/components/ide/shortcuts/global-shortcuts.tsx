import { getDesktopApi } from "@/lib/electron";
import { useChatSearchStore } from "../chat-search";
import { useIdeStore } from "../ide-store";
import { useShortcut, useShortcutDispatcher } from "./shortcuts";

const cycleProject = (step: 1 | -1) => {
  const { activeProjectId, projects, setActiveProjectId } =
    useIdeStore.getState();
  if (projects.length === 0) {
    return;
  }
  const index = projects.findIndex((project) => project.id === activeProjectId);
  // From the new-project page, Next lands on the first tab and Previous on
  // the last.
  const nextIndex =
    index === -1
      ? step === 1
        ? 0
        : projects.length - 1
      : (index + step + projects.length) % projects.length;
  const next = projects[nextIndex];
  if (next && next.id !== activeProjectId) {
    setActiveProjectId(next.id);
  }
};

const openProjectFolder = async () => {
  const desktopApi = getDesktopApi();
  if (!desktopApi) {
    return;
  }
  const selectedPath = await desktopApi.pickProjectDirectory();
  if (selectedPath) {
    const state = useIdeStore.getState();
    state.setSettingsOpen(false);
    state.addProject(selectedPath);
  }
};

/**
 * Installs the shortcut dispatcher and the shortcuts that belong to the whole
 * window rather than to one project. Renders nothing.
 */
export const GlobalShortcuts = () => {
  useShortcutDispatcher();

  const settingsOpen = useIdeStore((state) => state.settingsOpen);
  const setSettingsOpen = useIdeStore((state) => state.setSettingsOpen);
  const openChatSearch = useChatSearchStore((state) => state.setOpen);

  useShortcut("openSettings", () => setSettingsOpen(true), !settingsOpen);
  useShortcut("searchChats", () => openChatSearch(true));
  useShortcut("openProject", () => void openProjectFolder());
  useShortcut("nextProject", () => cycleProject(1), !settingsOpen);
  useShortcut("previousProject", () => cycleProject(-1), !settingsOpen);

  return null;
};
