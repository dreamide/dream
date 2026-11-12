import assert from "node:assert/strict";
import { test } from "vitest";
import { transcriptFingerprint } from "./session-context.js";
import { prepareTurnTranscript } from "./turn-transcript.js";

const message = (id, role, text, extra = {}) => ({
  id,
  role,
  parts: [{ type: "text", text }],
  ...extra,
});

const request = [
  message("1", "user", "start", { metadata: { ignored: true } }),
  message("2", "assistant", "done"),
  message("3", "user", "next"),
  message("4", "assistant", 'quote " and , comma'),
  message("5", "user", "go"),
];

test("every prefix fingerprint agrees with the whole-transcript fingerprint, in any order", () => {
  for (const order of [
    [0, 1, 2, 3, 4, 5],
    [5, 4, 3, 2, 1, 0],
    [2, 5, 0, 3],
  ]) {
    const transcript = prepareTurnTranscript(request);
    for (const length of order)
      assert.equal(
        transcript.fingerprint(length),
        transcriptFingerprint(request.slice(0, length)),
      );
  }
});

test("the fingerprint with the assistant message follows the request, or replaces a continued one", () => {
  const answer = message("a", "assistant", "answer");
  const fresh = prepareTurnTranscript(request);
  // Asked after a longer prefix was read, and before any was.
  fresh.fingerprint(request.length);
  assert.equal(
    fresh.fingerprintWith(answer),
    transcriptFingerprint([...request, answer]),
  );
  assert.equal(
    prepareTurnTranscript(request).fingerprintWith(answer),
    transcriptFingerprint([...request, answer]),
  );

  const continued = request.slice(0, 4);
  const transcript = prepareTurnTranscript(continued);
  assert.deepEqual(transcript.before, continued.slice(0, 3));
  transcript.fingerprint(4);
  assert.equal(
    transcript.fingerprintWith(answer),
    transcriptFingerprint([...continued.slice(0, 3), answer]),
  );

  const first = prepareTurnTranscript([]);
  assert.deepEqual(first.before, []);
  assert.equal(first.fingerprintWith(answer), transcriptFingerprint([answer]));
});

test("a request is saved only when its caller says so", () => {
  assert.equal(prepareTurnTranscript(request).saved, false);
  assert.equal(prepareTurnTranscript(request, { saved: true }).saved, true);
});
