import assert from "node:assert/strict";
import { test } from "vitest";
import { splitSkillMentions } from "./message-content";

test("a leading skill mention becomes a badge and leaves the text", () => {
  assert.deepEqual(
    splitSkillMentions(
      "$improve-codebase-architecture suggest improvement to our architecture",
      ["improve-codebase-architecture"],
    ),
    {
      badges: ["improve-codebase-architecture"],
      text: "suggest improvement to our architecture",
    },
  );
});

test("several leading mentions all become badges", () => {
  assert.deepEqual(
    splitSkillMentions("$tdd $grilling do it", ["grilling", "tdd"]),
    {
      badges: ["tdd", "grilling"],
      text: "do it",
    },
  );
});

test("a mid-sentence mention stays in the text without a badge", () => {
  assert.deepEqual(splitSkillMentions("please use $tdd here", ["tdd"]), {
    badges: [],
    text: "please use $tdd here",
  });
});

test("a mention missing from the text still gets a badge", () => {
  assert.deepEqual(splitSkillMentions("hello", ["tdd"]), {
    badges: ["tdd"],
    text: "hello",
  });
});

test("a longer name is not mistaken for a shorter one", () => {
  assert.deepEqual(splitSkillMentions("$tdd-lite go", ["tdd"]), {
    badges: ["tdd"],
    text: "$tdd-lite go",
  });
});
