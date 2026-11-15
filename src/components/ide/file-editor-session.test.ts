import { expect, test } from "vitest";
import { createFakeApiClient, fakeApiError } from "@/lib/api-client-fake";
import {
  createFileEditorSessions,
  type FileEditorSessionDependencies,
} from "./file-editor-session";

const PROJECT_ID = "project-1";
const PROJECT_PATH = "/work/app";
/** Another Project at the same path, on another Host. */
const REMOTE_PROJECT_ID = "project-2";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

/** Lets every settled read or write reach the session. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Sessions over an in-memory disk. `writeStatus` makes the next write fail
 * with that status; `readGate` holds a path's next read until released.
 */
const createHarness = (files: Record<string, string> = {}) => {
  const disk = new Map(Object.entries(files));
  const control = {
    readGate: new Map<string, Promise<void>>(),
    readStatus: new Map<string, number>(),
    writeStatus: null as number | null,
  };
  const saved: string[] = [];
  const fake = createFakeApiClient({
    readProjectFile: async ({ filePath }) => {
      await control.readGate.get(filePath);
      // Read when released, as a real read would be.
      const status = control.readStatus.get(filePath);
      if (status) throw fakeApiError("readProjectFile", status, "");
      const content = disk.get(filePath);
      if (content === undefined) {
        throw fakeApiError("readProjectFile", 404, "Not found.");
      }
      return {
        content,
        filePath,
        lineEnding: "lf",
        readOnlyReason: null,
        writable: true,
      };
    },
    writeProjectFile: async ({ content, expectedContent, filePath }) => {
      if (control.writeStatus) {
        const status = control.writeStatus;
        control.writeStatus = null;
        throw fakeApiError("writeProjectFile", status, "Write refused.");
      }
      if (disk.get(filePath) !== expectedContent) {
        throw fakeApiError("writeProjectFile", 409, "Changed on disk.");
      }
      disk.set(filePath, content);
      return {
        content,
        filePath,
        lineEnding: "lf",
        readOnlyReason: null,
        writable: true,
      };
    },
  });
  // The Host each read and write was sent to.
  const sent: { hostId: string | undefined; name: string }[] = [];
  const api: FileEditorSessionDependencies["api"] = {
    readProjectFile: (request, options) => {
      sent.push({ hostId: options?.hostId, name: "readProjectFile" });
      return fake.client.readProjectFile(request, options);
    },
    writeProjectFile: (request, options) => {
      sent.push({ hostId: options?.hostId, name: "writeProjectFile" });
      return fake.client.writeProjectFile(request, options);
    },
  };
  const sessions = createFileEditorSessions({
    api,
    getProjectScope: (projectId) =>
      projectId === PROJECT_ID
        ? { hostId: "local", projectPath: PROJECT_PATH }
        : projectId === REMOTE_PROJECT_ID
          ? { hostId: "devbox", projectPath: PROJECT_PATH }
          : null,
    onSaved: (projectId) => saved.push(projectId),
  });
  const session = sessions.session(PROJECT_ID);
  const readsOf = (path: string) =>
    fake.calls.filter(
      (call) =>
        call.name === "readProjectFile" &&
        (call.request as { filePath: string }).filePath === path,
    ).length;
  return { control, disk, readsOf, saved, sent, session, sessions };
};

test("opening a file shows it in the preview tab and reads it", async () => {
  const { session } = createHarness({ "src/a.ts": "a" });

  session.open("src/a.ts");
  expect(session.getSnapshot().reads["src/a.ts"]?.status).toBe("loading");
  await flush();

  const snapshot = session.getSnapshot();
  expect(snapshot.activePath).toBe("src/a.ts");
  expect(snapshot.tabs).toEqual([{ path: "src/a.ts", pinned: false }]);
  expect(snapshot.buffers["src/a.ts"]?.draftContent).toBe("a");
  expect(snapshot.reads["src/a.ts"]).toMatchObject({
    metadata: { lineEnding: "lf", writable: true },
    status: "ready",
  });
});

test("an image is shown, never read as text", async () => {
  const { readsOf, session } = createHarness();
  session.open("logo.png");
  await flush();
  expect(session.getSnapshot().activePath).toBe("logo.png");
  expect(readsOf("logo.png")).toBe(0);
});

test("a file too large or binary is unavailable, not failed", async () => {
  const { control, session } = createHarness({ "big.bin": "" });
  control.readStatus.set("big.bin", 413);
  session.open("big.bin");
  await flush();
  expect(session.getSnapshot().reads["big.bin"]?.status).toBe("unavailable");
});

test("the session, and a draft in it, outlive any panel showing them", async () => {
  const { session, sessions } = createHarness({ "a.ts": "disk" });
  session.open("a.ts");
  await flush();
  session.edit("a.ts", "draft");

  // A panel that remounts asks for the project's session again.
  const again = sessions.session(PROJECT_ID);
  expect(again).toBe(session);
  expect(again.getSnapshot().buffers["a.ts"]?.draftContent).toBe("draft");
});

test("editing a preview tab pins it, so the next open does not replace it", async () => {
  const { session } = createHarness({ "a.ts": "a", "b.ts": "b" });
  session.open("a.ts");
  await flush();
  session.edit("a.ts", "changed");
  session.open("b.ts");

  expect(session.getSnapshot().tabs).toEqual([
    { path: "a.ts", pinned: true },
    { path: "b.ts", pinned: false },
  ]);
});

test("closing a clean tab forgets the file, so reopening reads disk", async () => {
  const { disk, readsOf, session } = createHarness({ "a.ts": "old" });
  session.open("a.ts", { pin: true });
  await flush();

  expect(session.close("a.ts")).toBe("closed");
  disk.set("a.ts", "new");
  session.open("a.ts");
  await flush();

  expect(readsOf("a.ts")).toBe(2);
  expect(session.getSnapshot().buffers["a.ts"]?.diskContent).toBe("new");
});

test("a preview tab another file replaces is forgotten too", async () => {
  const { session } = createHarness({ "a.ts": "a", "b.ts": "b" });
  session.open("a.ts");
  await flush();
  session.open("b.ts");
  await flush();

  const snapshot = session.getSnapshot();
  expect(snapshot.buffers["a.ts"]).toBeUndefined();
  expect(snapshot.reads["a.ts"]).toBeUndefined();
});

test("closing a tab with unsaved changes asks first; discarding closes it", async () => {
  const { session } = createHarness({ "a.ts": "disk" });
  session.open("a.ts");
  await flush();
  session.edit("a.ts", "draft");

  expect(session.close("a.ts")).toBe("confirm");
  expect(session.getSnapshot().tabs).toHaveLength(1);

  session.discardAndClose("a.ts");
  expect(session.getSnapshot().tabs).toEqual([]);
  expect(session.getSnapshot().buffers["a.ts"]).toBeUndefined();
});

test("saving writes the draft and tells the store the project changed", async () => {
  const { disk, saved, session } = createHarness({ "a.ts": "disk" });
  session.open("a.ts");
  await flush();
  session.edit("a.ts", "draft");

  await expect(session.save("a.ts")).resolves.toBe(true);

  expect(disk.get("a.ts")).toBe("draft");
  expect(session.getSnapshot().buffers["a.ts"]).toMatchObject({
    diskContent: "draft",
    status: "clean",
  });
  expect(saved).toEqual([PROJECT_ID]);
});

test("a save the disk changed under is a conflict; reloading reads disk and drops the draft", async () => {
  const { disk, session } = createHarness({ "a.ts": "disk" });
  session.open("a.ts");
  await flush();
  session.edit("a.ts", "draft");
  disk.set("a.ts", "someone else");

  await expect(session.save("a.ts")).resolves.toBe(false);
  expect(session.getSnapshot().buffers["a.ts"]?.status).toBe("conflict");

  session.reload("a.ts");
  await flush();
  expect(session.getSnapshot().buffers["a.ts"]).toMatchObject({
    draftContent: "someone else",
    status: "clean",
  });
});

test("save-and-close that fails keeps the tab, shows it, and keeps the draft", async () => {
  const { control, session } = createHarness({ "a.ts": "a", "b.ts": "b" });
  session.open("a.ts", { pin: true });
  await flush();
  session.edit("a.ts", "draft");
  session.open("b.ts", { pin: true });
  await flush();
  control.writeStatus = 500;

  await expect(session.saveAndClose("a.ts")).resolves.toBe(false);

  const snapshot = session.getSnapshot();
  expect(snapshot.activePath).toBe("a.ts");
  expect(snapshot.buffers["a.ts"]).toMatchObject({
    draftContent: "draft",
    status: "dirty",
  });
  expect(snapshot.buffers["a.ts"]?.error).toBeInstanceOf(Error);
});

test("a refresh reads clean files again and keeps drafts", async () => {
  const { disk, session, sessions } = createHarness({
    "a.ts": "a",
    "b.ts": "b",
  });
  session.open("b.ts", { pin: true });
  await flush();
  session.edit("b.ts", "draft b");
  session.open("a.ts", { pin: true });
  await flush();
  disk.set("a.ts", "a changed");
  disk.set("b.ts", "b changed");

  sessions.refresh(PROJECT_ID);
  await flush();

  const { buffers } = session.getSnapshot();
  expect(buffers["a.ts"]?.draftContent).toBe("a changed");
  expect(buffers["b.ts"]).toMatchObject({
    diskContent: "b",
    draftContent: "draft b",
  });
});

test("a read that finishes after its file was closed is ignored", async () => {
  const { control, session } = createHarness({ "a.ts": "stale" });
  const gate = deferred<void>();
  control.readGate.set("a.ts", gate.promise);
  session.open("a.ts", { pin: true });
  session.close("a.ts");

  gate.resolve();
  await flush();

  const snapshot = session.getSnapshot();
  expect(snapshot.buffers["a.ts"]).toBeUndefined();
  expect(snapshot.reads["a.ts"]).toBeUndefined();
});

test("opening at a position asks the editor to reveal it, each time anew", () => {
  const { session } = createHarness({ "a.ts": "a" });
  const position = { column: 2, length: 3, line: 4 };

  session.open("a.ts", { position });
  const first = session.getSnapshot().reveal;
  session.open("a.ts", { focus: true, position });
  const second = session.getSnapshot().reveal;

  expect(first).toMatchObject({ ...position, focus: false, path: "a.ts" });
  expect(second?.focus).toBe(true);
  expect(second?.requestId).toBeGreaterThan(first?.requestId ?? 0);
});

test("a file the tree reports missing closes its tab", async () => {
  const { session } = createHarness({ "a.ts": "a" });
  session.open("a.ts");
  await flush();
  session.forgetMissing("a.ts");
  expect(session.getSnapshot().tabs).toEqual([]);
});

test("dropping a project's session starts the next one empty", async () => {
  const { session, sessions } = createHarness({ "a.ts": "a" });
  session.open("a.ts");
  await flush();

  sessions.drop(PROJECT_ID);

  expect(sessions.session(PROJECT_ID).getSnapshot().tabs).toEqual([]);
});

test("subscribers hear every change", async () => {
  const { session } = createHarness({ "a.ts": "a" });
  let notified = 0;
  const unsubscribe = session.subscribe(() => {
    notified += 1;
  });
  session.open("a.ts");
  await flush();
  unsubscribe();
  session.close("a.ts");
  // The open, then the read arriving; nothing after unsubscribing.
  expect(notified).toBe(2);
});

test("showing a file whose read failed reads it again", async () => {
  const { control, readsOf, session } = createHarness({
    "a.ts": "a",
    "b.ts": "b",
  });
  control.readStatus.set("a.ts", 500);
  session.open("a.ts", { pin: true });
  await flush();
  expect(session.getSnapshot().reads["a.ts"]?.status).toBe("failed");

  control.readStatus.delete("a.ts");
  session.open("b.ts", { pin: true });
  session.activate("a.ts");
  await flush();

  expect(readsOf("a.ts")).toBe(2);
  expect(session.getSnapshot().buffers["a.ts"]?.draftContent).toBe("a");
});

test("reads and writes go to the session's own Project Host, whatever shares its path", async () => {
  const { sent, session, sessions } = createHarness({ "a.ts": "disk" });
  const remote = sessions.session(REMOTE_PROJECT_ID);
  remote.open("a.ts");
  await flush();
  remote.edit("a.ts", "draft");
  await remote.save("a.ts");
  session.open("a.ts");
  await flush();

  expect(sent).toEqual([
    { hostId: "devbox", name: "readProjectFile" },
    { hostId: "devbox", name: "writeProjectFile" },
    { hostId: "local", name: "readProjectFile" },
  ]);
});
