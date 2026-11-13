// Chat drafts through their interface: a draft per chat, kept whole (text
// and references), added to from outside, emptied on send, and walked back
// through the prompts sent before.
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import type { ProjectReference } from "@/types/ide";
import {
  appendDraftText,
  createChatDrafts,
  promptHistoryOf,
} from "./chat-drafts";

const reference = { path: "src/app.ts" } as ProjectReference;
const draft = (text: string, references: ProjectReference[] = []) => ({
  references,
  text,
});

test("each chat has its own draft, the same object until it changes", () => {
  const drafts = createChatDrafts();
  const heard: string[] = [];
  drafts.subscribe("a", () => heard.push("a"));
  drafts.subscribe("b", () => heard.push("b"));

  const written = draft("Fix the header", [reference]);
  drafts.set("a", written);
  assert.equal(drafts.get("a"), written);
  assert.equal(drafts.get("a"), drafts.get("a"));
  assert.deepEqual(drafts.get("b"), draft(""));
  assert.deepEqual(heard, ["a"]);

  drafts.set("a", written);
  assert.deepEqual(heard, ["a"], "setting the same draft says nothing");
});

test("text added from outside goes after the draft, a blank line between", () => {
  assert.equal(appendDraftText("", "Returned"), "Returned");
  assert.equal(appendDraftText("Mine  \n", "Returned"), "Mine\n\nReturned");

  const drafts = createChatDrafts();
  drafts.set("a", draft("Mine", [reference]));
  drafts.append("a", "Make this button blue");
  assert.deepEqual(
    drafts.get("a"),
    draft("Mine\n\nMake this button blue", [reference]),
  );
  // A chat no panel shows keeps what came back.
  drafts.append("b", "Returned");
  assert.equal(drafts.get("b").text, "Returned");
  drafts.append("b", "");
  assert.equal(drafts.get("b").text, "Returned");
});

test("a sent draft empties, references and all", () => {
  const drafts = createChatDrafts();
  drafts.set("a", draft("Send me", [reference]));
  drafts.clear("a");
  assert.deepEqual(drafts.get("a"), draft(""));
});

const sent = (...texts: string[]): UIMessage[] =>
  texts.flatMap((text, index) => [
    {
      id: `u${index}`,
      parts: [{ text, type: "text" }],
      role: "user",
    } as UIMessage,
    {
      id: `a${index}`,
      parts: [{ text: "Answer", type: "text" }],
      role: "assistant",
    } as UIMessage,
  ]);

test("the history is what the user sent, oldest first, without blanks", () => {
  assert.deepEqual(promptHistoryOf(sent("first", "  ", " second ")), [
    "first",
    "second",
  ]);
});

test("Up walks back through what was sent, and Down returns to the draft as it was", () => {
  const drafts = createChatDrafts();
  const history = ["first", "second"];
  const mine = draft("half written", [reference]);
  drafts.set("a", mine);
  const step = (key: "ArrowUp" | "ArrowDown", caretAtStart = true) =>
    drafts.stepHistory("a", key, { caretAtStart, history });

  // Only from the start of the draft, and only Up.
  assert.equal(step("ArrowUp", false), false);
  assert.equal(step("ArrowDown"), false);

  assert.equal(step("ArrowUp"), true);
  assert.deepEqual(drafts.get("a"), draft("second"));
  // Once walking, the caret's place does not matter.
  assert.equal(step("ArrowUp", false), true);
  assert.deepEqual(drafts.get("a"), draft("first"));
  assert.equal(step("ArrowUp"), false, "nothing before the first");

  assert.equal(step("ArrowDown"), true);
  assert.deepEqual(drafts.get("a"), draft("second"));
  assert.equal(step("ArrowDown"), true);
  // The draft comes back whole, its picked file included.
  assert.equal(drafts.get("a"), mine);
  assert.equal(step("ArrowDown"), false);
});

test("Up does nothing with nothing sent, and sending ends the walk", () => {
  const drafts = createChatDrafts();
  assert.equal(
    drafts.stepHistory("a", "ArrowUp", { caretAtStart: true, history: [] }),
    false,
  );

  const history = ["first"];
  drafts.stepHistory("a", "ArrowUp", { caretAtStart: true, history });
  drafts.clear("a");
  assert.equal(
    drafts.stepHistory("a", "ArrowDown", { caretAtStart: true, history }),
    false,
  );
  assert.deepEqual(drafts.get("a"), draft(""));
});
