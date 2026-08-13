import assert from "node:assert/strict";
import { test } from "vitest";
import {
  CHAT_TRANSCRIPT_WINDOW_SIZE,
  getTranscriptWindow,
} from "./transcript-window";

test("returns the full transcript when it fits in the window", () => {
  const messages = ["one", "two", "three"];
  const transcript = getTranscriptWindow(messages, CHAT_TRANSCRIPT_WINDOW_SIZE);

  assert.deepEqual(transcript.messages, messages);
  assert.equal(transcript.hiddenMessageCount, 0);
  assert.equal(transcript.startIndex, 0);
});

test("keeps only the newest messages in a long transcript", () => {
  const messages = Array.from({ length: 100 }, (_, index) => index);
  const transcript = getTranscriptWindow(messages, 40);

  assert.deepEqual(transcript.messages, messages.slice(60));
  assert.equal(transcript.hiddenMessageCount, 60);
  assert.equal(transcript.startIndex, 60);
});

test("normalizes invalid window sizes", () => {
  const transcript = getTranscriptWindow(["one", "two"], 0);

  assert.deepEqual(transcript.messages, ["two"]);
  assert.equal(transcript.hiddenMessageCount, 1);
});
