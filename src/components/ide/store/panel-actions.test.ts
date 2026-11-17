// Right-panel navigation and opening a project file. What the right panel
// shows changes only through these operations, so the rules that go with a
// view (leaving the terminal discards untouched shells) hold for every
// caller. A project file's path is resolved once, the file opens in the
// project's session, and nothing is left in the store to be replayed later.
import { expect, test, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { createFakeApiClient } from "@/lib/api-client-fake";
import { createProjectConfig, DEFAULT_SETTINGS } from "@/lib/ide-defaults";
import { createFileEditorSessions } from "../file-editor-session";
import type { RightPanelView } from "../ide-types";
import type { IdeState } from "./ide-store-types";
import { createPanelActions } from "./panel-actions";

const createTestStore = (
  ui: { rightPanelOpen?: boolean; rightPanelView?: RightPanelView } = {},
) => {
  const base = createProjectConfig("/work/app", DEFAULT_SETTINGS);
  const project = { ...base, ui: { ...base.ui, ...ui } };
  const fileEditor = createFileEditorSessions({
    api: createFakeApiClient({
      readProjectFile: ({ filePath }) => ({
        content: "",
        filePath,
        lineEnding: "lf",
        readOnlyReason: null,
        writable: true,
      }),
    }).client,
    getProjectScope: () => ({ hostId: "local", projectPath: project.path }),
  });
  const discardUntouchedTerminals = vi.fn();
  const openProjectTerminal = vi.fn(async () => {});
  const store = createStore<IdeState>(
    () =>
      ({
        openProjectTerminal,
        projectFileSearchRequests: {},
        projectGitPanelTabByProject: {},
        projects: [project],
      }) as unknown as IdeState,
  );
  store.setState(
    createPanelActions(store.setState, store.getState, {
      fileEditor,
      terminals: { discardUntouched: discardUntouchedTerminals },
    }),
  );
  const panel = () => {
    const { rightPanelOpen, rightPanelView } =
      store.getState().projects[0]?.ui ?? project.ui;
    return { rightPanelOpen, rightPanelView };
  };
  return {
    discardUntouchedTerminals,
    fileEditor,
    openProjectTerminal,
    panel,
    project,
    store,
  };
};

const onTerminal = {
  rightPanelOpen: true,
  rightPanelView: "terminal",
} as const;

test("every way of leaving the terminal view discards untouched terminals", () => {
  const leave: Record<
    string,
    (store: ReturnType<typeof createTestStore>) => void
  > = {
    "another view": ({ project, store }) =>
      store.getState().showRightPanelView(project.id, "git"),
    "closing the panel": ({ project, store }) =>
      store.getState().closeRightPanel(project.id),
    "toggling the panel": ({ project, store }) =>
      store.getState().toggleRightPanel(project.id),
    "toggling the terminal": ({ project, store }) =>
      store
        .getState()
        .showRightPanelView(project.id, "terminal", { toggle: true }),
    "opening a file": ({ project, store }) =>
      store.getState().openProjectFile(project.id, "src/a.ts"),
    "find in files": ({ project, store }) =>
      store.getState().openProjectFileSearch(project.id),
  };

  for (const [route, act] of Object.entries(leave)) {
    const harness = createTestStore(onTerminal);
    act(harness);
    expect(
      harness.discardUntouchedTerminals,
      `leaving by ${route}`,
    ).toHaveBeenCalledWith(harness.project.id);
  }
});

test("switching between other views discards nothing", () => {
  const { discardUntouchedTerminals, panel, project, store } = createTestStore({
    rightPanelOpen: true,
    rightPanelView: "git",
  });
  store.getState().showRightPanelView(project.id, "browser");
  expect(panel()).toEqual({ rightPanelOpen: true, rightPanelView: "browser" });
  expect(discardUntouchedTerminals).not.toHaveBeenCalled();
});

test("showing the terminal view starts a terminal", () => {
  const { openProjectTerminal, panel, project, store } = createTestStore();
  store.getState().showRightPanelView(project.id, "terminal");
  expect(panel()).toEqual({ rightPanelOpen: true, rightPanelView: "terminal" });
  expect(openProjectTerminal).toHaveBeenCalledWith(project.id);
});

test("a toggle closes a view that is already showing; without it the view stays", () => {
  const { panel, project, store } = createTestStore({
    rightPanelOpen: true,
    rightPanelView: "explorer",
  });

  store.getState().showRightPanelView(project.id, "explorer");
  expect(panel().rightPanelOpen).toBe(true);

  store.getState().showRightPanelView(project.id, "explorer", { toggle: true });
  expect(panel()).toEqual({
    rightPanelOpen: false,
    rightPanelView: "explorer",
  });

  // Opening again shows the view it last showed.
  store.getState().toggleRightPanel(project.id);
  expect(panel()).toEqual({ rightPanelOpen: true, rightPanelView: "explorer" });
});

test("a Git tab toggle switches tabs while the Git panel shows, and closes it on the tab it shows", () => {
  const { panel, project, store } = createTestStore({
    rightPanelOpen: true,
    rightPanelView: "git",
  });
  const showTab = (gitTab: "changes" | "pull-request") =>
    store
      .getState()
      .showRightPanelView(project.id, "git", { gitTab, toggle: true });

  showTab("pull-request");
  expect(panel().rightPanelOpen).toBe(true);
  expect(store.getState().projectGitPanelTabByProject[project.id]).toBe(
    "pull-request",
  );

  showTab("pull-request");
  expect(panel().rightPanelOpen).toBe(false);
});

test("an absolute path inside the project opens as its project-relative path, in the Files view", () => {
  const { fileEditor, project, store } = createTestStore();

  const opened = store
    .getState()
    .openProjectFile(project.id, "/work/app/src/a.ts", {
      column: 0,
      length: 1,
      line: 3,
    });

  expect(opened).toBe(true);
  const snapshot = fileEditor.session(project.id).getSnapshot();
  expect(snapshot.tabs).toEqual([{ path: "src/a.ts", pinned: false }]);
  expect(snapshot.reveal).toMatchObject({ line: 3, path: "src/a.ts" });
  expect(store.getState().projects[0]?.ui).toMatchObject({
    rightPanelOpen: true,
    rightPanelView: "explorer",
  });
});

test("the same file named two ways opens one tab", () => {
  const { fileEditor, project, store } = createTestStore();

  store.getState().openProjectFile(project.id, "/work/app/src/a.ts");
  store.getState().openProjectFile(project.id, "./src/a.ts");

  expect(fileEditor.session(project.id).getSnapshot().tabs).toHaveLength(1);
});

test("a path outside the project, or an unknown project, opens nothing", () => {
  const { fileEditor, project, store } = createTestStore();

  expect(store.getState().openProjectFile(project.id, "/elsewhere/a.ts")).toBe(
    false,
  );
  expect(store.getState().openProjectFile("nope", "src/a.ts")).toBe(false);
  expect(fileEditor.session(project.id).getSnapshot().tabs).toEqual([]);
  expect(store.getState().projects[0]?.ui.rightPanelOpen).toBe(
    project.ui.rightPanelOpen,
  );
});
