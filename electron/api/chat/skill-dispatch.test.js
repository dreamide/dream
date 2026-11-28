import assert from "node:assert/strict";
import { test } from "vitest";
import {
  applySkillDispatchToMessages,
  findSkillMentions,
  getMessageText,
  planSkillDispatch,
} from "./skill-dispatch.js";
import { applySkillSlashPrefix } from "./turn-prompt.js";

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

test("findSkillMentions preserves first-wins precedence for duplicate names", () => {
  const duplicateCatalog = [
    {
      enabled: true,
      name: "deploy",
      path: "/project/deploy/SKILL.md",
      scope: "project",
    },
    {
      enabled: true,
      name: "deploy",
      path: "/user/deploy/SKILL.md",
      scope: "user",
    },
  ];
  const mentions = findSkillMentions("run $deploy", duplicateCatalog);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].skill.scope, "project");
  assert.equal(mentions[0].skill.path, "/project/deploy/SKILL.md");
});

test("Antigravity plan resolves qualified plugin skills distinctly from project skills", () => {
  const catalog = [
    {
      enabled: true,
      name: "deploy",
      path: "/project/deploy/SKILL.md",
      scope: "project",
    },
    {
      enabled: true,
      name: "plugin-a:deploy",
      path: "/plugins/plugin-a/deploy/SKILL.md",
      pluginId: "plugin-a",
      scope: "plugin",
    },
    {
      enabled: true,
      name: "plugin-b:deploy",
      path: "/plugins/plugin-b/deploy/SKILL.md",
      pluginId: "plugin-b",
      scope: "plugin",
    },
  ];

  const pluginPlan = planSkillDispatch({
    provider: "antigravity",
    skills: catalog,
    text: "run $deploy then $plugin-a:deploy",
  });
  assert.deepEqual(
    pluginPlan.skills.map((s) => s.name),
    ["deploy", "plugin-a:deploy"],
  );
  assert.equal(pluginPlan.slashCommand, "plugin-a:deploy");
  assert.equal(
    applySkillSlashPrefix(
      "run $deploy then $plugin-a:deploy",
      pluginPlan.slashCommand,
    ),
    "/plugin-a:deploy run $deploy then $plugin-a:deploy",
  );

  const projectPlan = planSkillDispatch({
    provider: "antigravity",
    skills: catalog,
    text: "run $plugin-b:deploy then $deploy",
  });
  assert.deepEqual(
    projectPlan.skills.map((s) => s.name),
    ["plugin-b:deploy", "deploy"],
  );
  assert.equal(projectPlan.slashCommand, "deploy");
});
