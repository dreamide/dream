import type { UIMessage } from "ai";
import { useRef } from "react";

/**
 * Keeping a live turn's unchanged parts the same objects from one stream
 * update to the next.
 *
 * On every chunk the AI SDK hands the view a fresh copy of the message being
 * written, every part copied with it, so nothing the turn already finished
 * keeps its identity and every memo keyed on a part misses. Here each part
 * that says the same as last time is the previous object again, and a
 * message whose parts and fields all held is the previous message.
 *
 * What comes out is never changed in place: a part taken from the stream is
 * copied first, because the message the SDK first shows for a turn is the
 * one it is still writing into. So a part's identity stands for its content,
 * and a cache keyed on it stays right.
 */

type Part = UIMessage["parts"][number];

const shallowEqual = (a: object, b: object) => {
  if (a === b) return true;
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  if (keys.length !== Object.keys(bRecord).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(bRecord, key) || aRecord[key] !== bRecord[key]) {
      return false;
    }
  }
  return true;
};

const sameValue = (a: unknown, b: unknown) =>
  a === b ||
  (a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    shallowEqual(a, b));

const stabilizeMessage = (
  previous: UIMessage | undefined,
  next: UIMessage,
): UIMessage => {
  if (previous === next) return next;
  const previousParts =
    previous && previous.id === next.id ? previous.parts : [];
  let partsHeld = previousParts.length === next.parts.length;
  const parts = next.parts.map((part, index) => {
    const previousPart = previousParts[index];
    if (previousPart && shallowEqual(previousPart, part)) return previousPart;
    partsHeld = false;
    return { ...part } as Part;
  });
  if (!previous || previous.id !== next.id) {
    return { ...next, parts };
  }

  const metadata = sameValue(previous.metadata, next.metadata)
    ? previous.metadata
    : next.metadata && typeof next.metadata === "object"
      ? { ...next.metadata }
      : next.metadata;
  const nextFields = next as unknown as Record<string, unknown>;
  const previousFields = previous as unknown as Record<string, unknown>;
  const fieldsHeld = Object.keys(next).every(
    (key) =>
      key === "parts" ||
      key === "metadata" ||
      nextFields[key] === previousFields[key],
  );
  if (
    partsHeld &&
    fieldsHeld &&
    metadata === previous.metadata &&
    Object.keys(previous).length === Object.keys(next).length
  ) {
    return previous;
  }
  return { ...next, metadata, parts };
};

/**
 * `next`, with every message and part that says the same as in `previous`
 * (the last result) replaced by the object it was there. The array itself
 * is `previous` again when nothing changed.
 */
export const stabilizeMessages = (
  previous: readonly UIMessage[] | null,
  next: readonly UIMessage[],
): UIMessage[] => {
  let changed = !previous || previous.length !== next.length;
  const messages = next.map((message, index) => {
    const stable = stabilizeMessage(previous?.[index], message);
    if (stable !== previous?.[index]) changed = true;
    return stable;
  });
  return changed || !previous ? messages : (previous as UIMessage[]);
};

/** `messages`, kept stable across renders by `stabilizeMessages`. */
export const useStableMessages = (messages: UIMessage[]) => {
  const ref = useRef<{ input: UIMessage[]; output: UIMessage[] } | null>(null);
  const last = ref.current;
  if (last?.input === messages) return last.output;
  const output = stabilizeMessages(last?.output ?? null, messages);
  ref.current = { input: messages, output };
  return output;
};

/**
 * `next`, or `previous` when they hold the same items in the same order: an
 * array derived afresh on each render that should only change when what is
 * in it does.
 */
export const reuseIfSameItems = <T>(
  previous: readonly T[] | null,
  next: T[],
): T[] =>
  previous &&
  previous.length === next.length &&
  previous.every((item, index) => item === next[index])
    ? (previous as T[])
    : next;
