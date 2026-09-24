import assert from "node:assert/strict";
import { test } from "vitest";
import {
  canGoBackInNavHistory,
  canGoForwardInNavHistory,
  EMPTY_NAV_HISTORY,
  MAX_NAV_HISTORY_ENTRIES,
  type NavHistory,
  type NavLocation,
  pruneNavHistory,
  recordNavLocation,
  replaceCurrentNavLocation,
  stepNavHistory,
} from "./navigation-history";

const loc = (projectId: string, chatId: string | null = null): NavLocation => ({
  chatId,
  projectId,
});

const visit = (...locations: NavLocation[]) =>
  locations.reduce(recordNavLocation, EMPTY_NAV_HISTORY);

test("records visits and moves to the newest", () => {
  const history = visit(loc("a", "1"), loc("b", "2"), loc("b", "3"));

  assert.deepEqual(history.entries, [
    loc("a", "1"),
    loc("b", "2"),
    loc("b", "3"),
  ]);
  assert.equal(history.index, 2);
  assert.equal(canGoBackInNavHistory(history), true);
  assert.equal(canGoForwardInNavHistory(history), false);
});

test("ignores a repeat of the current location", () => {
  const history = visit(loc("a", "1"));

  assert.equal(recordNavLocation(history, loc("a", "1")), history);
});

test("folds a chat-less project visit into the chat it then gets", () => {
  const history = visit(loc("a", "1"), loc("b"), loc("b", "2"));

  assert.deepEqual(history.entries, [loc("a", "1"), loc("b", "2")]);
  assert.equal(history.index, 1);
});

test("a new visit after going back drops the forward entries", () => {
  const back = stepNavHistory(
    visit(loc("a", "1"), loc("b", "2"), loc("c", "3")),
    -1,
  ) as NavHistory;
  const history = recordNavLocation(back, loc("d", "4"));

  assert.deepEqual(history.entries, [
    loc("a", "1"),
    loc("b", "2"),
    loc("d", "4"),
  ]);
  assert.equal(canGoForwardInNavHistory(history), false);
});

test("stepping stops at both ends", () => {
  const history = visit(loc("a", "1"), loc("b", "2"));

  assert.equal(stepNavHistory(history, 1), null);
  const back = stepNavHistory(history, -1) as NavHistory;
  assert.equal(back.index, 0);
  assert.equal(stepNavHistory(back, -1), null);
  assert.equal(stepNavHistory(back, 1)?.index, 1);
  assert.equal(stepNavHistory(EMPTY_NAV_HISTORY, -1), null);
});

test("keeps only the newest entries once full", () => {
  let history = EMPTY_NAV_HISTORY;
  for (let i = 0; i < MAX_NAV_HISTORY_ENTRIES + 5; i += 1) {
    history = recordNavLocation(history, loc("a", String(i)));
  }

  assert.equal(history.entries.length, MAX_NAV_HISTORY_ENTRIES);
  assert.deepEqual(history.entries[0], loc("a", "5"));
  assert.equal(history.index, MAX_NAV_HISTORY_ENTRIES - 1);
});

test("pruning removes dead entries and keeps the current one", () => {
  const back = stepNavHistory(
    visit(loc("a", "1"), loc("closed", "2"), loc("b", "3"), loc("c", "4")),
    -1,
  ) as NavHistory;
  const pruned = pruneNavHistory(back, (entry) => entry.projectId !== "closed");

  assert.deepEqual(pruned.entries, [
    loc("a", "1"),
    loc("b", "3"),
    loc("c", "4"),
  ]);
  assert.deepEqual(pruned.entries[pruned.index], loc("b", "3"));
});

test("pruning merges neighbours that became identical", () => {
  const history = visit(loc("a", "1"), loc("b", "2"), loc("a", "1"));
  const pruned = pruneNavHistory(history, (entry) => entry.projectId !== "b");

  assert.deepEqual(pruned.entries, [loc("a", "1")]);
  assert.equal(pruned.index, 0);
});

test("pruning the current entry falls back to the one before it", () => {
  const history = visit(loc("a", "1"), loc("b", "2"), loc("c", "3"));
  const pruned = pruneNavHistory(history, (entry) => entry.projectId !== "c");

  assert.deepEqual(pruned.entries[pruned.index], loc("b", "2"));
});

test("pruning with nothing to remove returns the same history", () => {
  const history = visit(loc("a", "1"), loc("b", "2"));

  assert.equal(
    pruneNavHistory(history, () => true),
    history,
  );
});

test("pruning everything leaves an empty history", () => {
  const pruned = pruneNavHistory(visit(loc("a", "1")), () => false);

  assert.deepEqual(pruned, EMPTY_NAV_HISTORY);
});

test("replacing the current entry keeps the position", () => {
  const history = visit(loc("a", "1"), loc("b", "2"));
  const replaced = replaceCurrentNavLocation(history, loc("b", "9"));

  assert.deepEqual(replaced.entries, [loc("a", "1"), loc("b", "9")]);
  assert.equal(replaced.index, 1);
  assert.equal(replaceCurrentNavLocation(history, loc("b", "2")), history);
});
