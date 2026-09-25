import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applySkillDispatchToMessages,
  applySkillSlashPrefix,
  findSkillMentions,
  getMessageText,
  planSkillDispatch,
} from "./skill-dispatch.js";

const skills = [
  {
    description: "Deploy the app",
    enabled: true,
    name: "deploy",
    path: "/u/deploy/SKILL.md",
  },
  {
    enabled: true,
    name: "pdf",
    path: "/u/pdf/SKILL.md",
    userInvocationOnly: true,
  },
  { enabled: false, name: "off", path: "/u/off/SKILL.md" },
];

test("findSkillMentions only matches enabled, known skills", () => {
  const mentions = findSkillMentions(
    "please $deploy then $pdf, skip $off and $nope; costs $50",
    skills,
  );
  assert.deepEqual(
    mentions.map((m) => m.name),
    ["deploy", "pdf"],
  );
});

test("getMessageText joins text parts", () => {
  assert.equal(
    getMessageText({
      parts: [
        { text: "a", type: "text" },
        { type: "file" },
        { text: "b", type: "text" },
      ],
    }),
    "a\nb",
  );
});

test("Claude plan appends Skill tool / Read instructions", () => {
  const plan = planSkillDispatch({
    provider: "anthropic",
    skills,
    text: "$deploy and $pdf now",
  });
  assert.equal(plan.skills.length, 2);
  assert.match(
    plan.instruction,
    /"deploy" \(Deploy the app\): invoke it with the Skill tool/,
  );
  assert.match(
    plan.instruction,
    /"pdf": this skill only runs on user request, so read its instructions at \/u\/pdf\/SKILL\.md/,
  );
});

test("OpenCode plan points at the skill tool", () => {
  const plan = planSkillDispatch({
    provider: "opencode",
    skills,
    text: "$deploy",
  });
  assert.match(plan.instruction, /load it with the skill tool/);
});

test("Cursor plan uses the last mention as the slash command", () => {
  const plan = planSkillDispatch({
    provider: "cursor",
    skills,
    text: "$deploy then $pdf",
  });
  assert.equal(plan.slashCommand, "pdf");
  assert.equal(plan.instruction, undefined);
  assert.equal(applySkillSlashPrefix("do it", plan.slashCommand), "/pdf do it");
  assert.equal(applySkillSlashPrefix("do it", undefined), "do it");
});

test("Codex plan leaves the message alone", () => {
  const plan = planSkillDispatch({
    provider: "openai",
    skills,
    text: "$deploy",
  });
  assert.deepEqual(Object.keys(plan), ["skills"]);
});

test("no plan without a known mention", () => {
  assert.equal(
    planSkillDispatch({ provider: "anthropic", skills, text: "$nope $50" }),
    null,
  );
});

test("applySkillDispatchToMessages appends a text part to the latest user message", () => {
  const messages = [
    { parts: [{ text: "$deploy", type: "text" }], role: "user" },
    { parts: [{ text: "ok", type: "text" }], role: "assistant" },
    { parts: [{ text: "$deploy again", type: "text" }], role: "user" },
  ];
  const result = applySkillDispatchToMessages(messages, {
    instruction: "INSTR",
    skills: [],
  });
  assert.equal(result[0], messages[0]);
  assert.equal(result[1], messages[1]);
  assert.deepEqual(result[2].parts, [
    { text: "$deploy again", type: "text" },
    { text: "INSTR", type: "text" },
  ]);
  assert.equal(applySkillDispatchToMessages(messages, null), messages);
});
