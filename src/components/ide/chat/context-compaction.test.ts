import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { test } from "vitest";
import { getContextCompactionState } from "@/components/ide/chat/context-compaction";

const createPart = (value: unknown) => value as UIMessage["parts"][number];

test("reads context compaction lifecycle data parts", () => {
  assert.equal(
    getContextCompactionState(
      createPart({
        data: { state: "compacting" },
        id: "compact-1",
        type: "data-context-compaction",
      }),
    ),
    "compacting",
  );
  assert.equal(
    getContextCompactionState(
      createPart({
        data: { state: "compacted" },
        id: "compact-1",
        type: "data-context-compaction",
      }),
    ),
    "compacted",
  );
});

test("ignores unrelated and malformed data parts", () => {
  assert.equal(
    getContextCompactionState(
      createPart({ data: { state: "compacting" }, type: "data-todos" }),
    ),
    null,
  );
  assert.equal(
    getContextCompactionState(
      createPart({
        data: { state: "unknown" },
        type: "data-context-compaction",
      }),
    ),
    null,
  );
});
