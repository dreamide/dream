import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { getSessionFilesByMessage } from "./session-files";

const textMessage = (id: string, text: string): UIMessage => ({
  id,
  parts: [{ text, type: "text" }],
  role: "assistant",
});

const imageMessage = (id: string, session: string): UIMessage =>
  ({
    id,
    parts: [
      {
        input: {},
        output: {
          filename: "1.jpg",
          path: `/home/.grok/sessions/app/${session}/images/1.jpg`,
          session_folder: "images",
          type: "ImageGen",
        },
        state: "output-available",
        toolCallId: `call-${id}`,
        toolName: "command",
        type: "dynamic-tool",
      },
    ],
    role: "assistant",
  }) as UIMessage;

test("a session file resolves in its own message and every later one", () => {
  const files = getSessionFilesByMessage([
    textMessage("before", "draw it"),
    imageMessage("image", "s1"),
    textMessage("after", "[images/1.jpg](images/1.jpg)"),
  ]);

  assert.equal(files.get("before")?.get("images/1.jpg"), undefined);
  assert.equal(
    files.get("image")?.get("images/1.jpg"),
    "/home/.grok/sessions/app/s1/images/1.jpg",
  );
  assert.equal(
    files.get("after")?.get("images/1.jpg"),
    "/home/.grok/sessions/app/s1/images/1.jpg",
  );
});

test("a new session reusing a name leaves earlier links on the earlier file", () => {
  const files = getSessionFilesByMessage([
    imageMessage("first", "s1"),
    textMessage("first-link", "[images/1.jpg](images/1.jpg)"),
    imageMessage("second", "s2"),
    textMessage("second-link", "[images/1.jpg](images/1.jpg)"),
  ]);

  assert.equal(
    files.get("first-link")?.get("images/1.jpg"),
    "/home/.grok/sessions/app/s1/images/1.jpg",
  );
  assert.equal(
    files.get("second-link")?.get("images/1.jpg"),
    "/home/.grok/sessions/app/s2/images/1.jpg",
  );
});

test("given the last result, unchanged messages keep their maps and only the live one is read", () => {
  const settled = [
    textMessage("before", "draw it"),
    imageMessage("image", "s1"),
    textMessage("after", "[images/1.jpg](images/1.jpg)"),
  ];
  const first = getSessionFilesByMessage([
    ...settled,
    textMessage("live", "Dra"),
  ]);
  // The live message is a new object on every update.
  const second = getSessionFilesByMessage(
    [...settled, textMessage("live", "Drawing")],
    first,
  );
  for (const id of ["before", "image", "after", "live"])
    assert.equal(second.get(id), first.get(id), id);

  // A file the live message saves gives it, alone, a new map.
  const third = getSessionFilesByMessage(
    [...settled, imageMessage("live", "s2")],
    second,
  );
  for (const id of ["before", "image", "after"])
    assert.equal(third.get(id), second.get(id), id);
  assert.notEqual(third.get("live"), second.get("live"));
  assert.equal(
    third.get("live")?.get("images/1.jpg"),
    "/home/.grok/sessions/app/s2/images/1.jpg",
  );
});
