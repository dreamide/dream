// A turn's request transcript, prepared once for everything that reads it
// while the turn runs: where the assistant message goes, whether the
// request is already in the catalog, and the fingerprints a Provider
// session is resumed by (provider-session.js).
//
// A fingerprint is the sha256 of the messages' `{ id, role, parts }` as one
// JSON array. JSON of an array is its elements' JSON joined by commas inside
// brackets, so the hash is fed one message at a time and copied where a
// prefix ends: every fingerprint of the request is read off one pass over
// it, and the end of the turn adds only its own message.

import { createHash } from "node:crypto";

/** The fingerprint of `messages` as a whole, without a prepared pass. */
export const transcriptFingerprint = (messages) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        messages.map(({ id, role, parts }) => ({ id, role, parts })),
      ),
    )
    .digest("hex");

const fingerprintPart = ({ id, role, parts }) =>
  JSON.stringify({ id, role, parts });

/**
 * Fingerprints of `messages`' prefixes from one pass, with the state after
 * the first `boundary` messages kept for `with`.
 */
const createPrefixFingerprints = (messages, boundary) => {
  const hash = createHash("sha256").update("[");
  let count = 0;
  let atBoundary = boundary === 0 ? hash.copy() : null;

  const advance = (to) => {
    while (count < to) {
      if (count > 0) hash.update(",");
      hash.update(fingerprintPart(messages[count]));
      count += 1;
      if (count === boundary) atBoundary = hash.copy();
    }
  };

  return {
    /** The fingerprint of the first `length` messages. */
    of(length) {
      // Asked out of order: rare, and answered the long way.
      if (length < count)
        return transcriptFingerprint(messages.slice(0, length));
      advance(length);
      return hash.copy().update("]").digest("hex");
    },
    /** The fingerprint of the first `boundary` messages, then `message`. */
    with(message) {
      if (!atBoundary) advance(boundary);
      const next = /** @type {import("node:crypto").Hash} */ (
        atBoundary
      ).copy();
      if (boundary > 0) next.update(",");
      return next.update(fingerprintPart(message)).update("]").digest("hex");
    },
  };
};

/**
 * @param {Array<{ id: string, role: string, parts: unknown[] }>} messages
 *   the request: the transcript the turn answers
 * @param {{ saved?: boolean }} [options] `saved`: the request is already
 *   in the catalog as it is (a Chat run saved it), so the turn's saves
 *   write only its own message
 */
export const prepareTurnTranscript = (messages, { saved = false } = {}) => {
  const continued = messages.at(-1)?.role === "assistant";
  // The assistant message replaces the last one when the turn continues it.
  const before = continued ? messages.slice(0, -1) : messages;
  const fingerprints = createPrefixFingerprints(messages, before.length);
  return {
    messages,
    /** What the assistant message is written after. */
    before,
    saved,
    /** The fingerprint of the request's first `length` messages. */
    fingerprint: (length) => fingerprints.of(length),
    /** The fingerprint of the transcript once `message` is written. */
    fingerprintWith: (message) => fingerprints.with(message),
  };
};
