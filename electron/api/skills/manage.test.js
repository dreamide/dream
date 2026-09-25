import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  buildSkillMarkdown,
  createSkill,
  resolveSkillTargetDirectory,
  setClaudeSkillEnabled,
  toSkillName,
  validateSkillInput,
} from "./manage.js";

let tempRoot;
let home;
let project;
const previousEnv = {};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skill-manage-"));
  home = path.join(tempRoot, "home");
  project = path.join(tempRoot, "repo");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(project, { recursive: true });
  for (const key of ["DREAM_SKILLS_HOME", "CLAUDE_CONFIG_DIR"]) {
    previousEnv[key] = process.env[key];
  }
  process.env.DREAM_SKILLS_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = "";
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await fs.rm(tempRoot, { force: true, recursive: true });
});

test("toSkillName slugs arbitrary names", () => {
  assert.equal(toSkillName("Release Checklist!"), "release-checklist");
  assert.equal(toSkillName("  --Foo__Bar--  "), "foo-bar");
  assert.equal(toSkillName("x".repeat(80)).length, 64);
});

test("validateSkillInput enforces the spec", () => {
  assert.equal(validateSkillInput({ description: "d", name: "ok-name" }), null);
  assert.match(
    validateSkillInput({ description: "d", name: "Bad Name" }),
    /lowercase/,
  );
  assert.match(
    validateSkillInput({ description: "d", name: "a--b" }),
    /lowercase/,
  );
  assert.match(
    validateSkillInput({ description: " ", name: "ok" }),
    /description/,
  );
});

test("buildSkillMarkdown writes spec front matter", () => {
  const markdown = buildSkillMarkdown({
    body: "Do the thing.\r\n",
    description: 'Say "hi"',
    name: "greet",
    userInvocationOnly: true,
  });
  assert.equal(
    markdown,
    [
      "---",
      "name: greet",
      'description: "Say \\"hi\\""',
      "disable-model-invocation: true",
      "---",
      "",
      "Do the thing.",
      "",
    ].join("\n"),
  );
});

test("resolveSkillTargetDirectory maps targets", () => {
  assert.equal(
    resolveSkillTargetDirectory("project-agents", { projectPath: project }),
    path.join(project, ".agents", "skills"),
  );
  assert.equal(
    resolveSkillTargetDirectory("project-claude", { projectPath: project }),
    path.join(project, ".claude", "skills"),
  );
  assert.equal(
    resolveSkillTargetDirectory("user-agents", {}),
    path.join(home, ".agents", "skills"),
  );
  assert.equal(
    resolveSkillTargetDirectory("user-claude", {}),
    path.join(home, ".claude", "skills"),
  );
  assert.throws(
    () => resolveSkillTargetDirectory("project-agents", {}),
    /project/,
  );
});

test("createSkill writes SKILL.md into every target and refuses overwrites", async () => {
  const result = await createSkill({
    body: "Steps",
    description: "Ship it",
    name: "ship",
    projectPath: project,
    targets: ["project-agents", "project-claude"],
  });
  assert.deepEqual(result.paths, [
    path.join(project, ".agents", "skills", "ship", "SKILL.md"),
    path.join(project, ".claude", "skills", "ship", "SKILL.md"),
  ]);
  const text = await fs.readFile(result.paths[1], "utf8");
  assert.match(
    text,
    /^---\nname: ship\ndescription: "Ship it"\n---\n\nSteps\n$/,
  );

  await assert.rejects(
    createSkill({
      description: "Ship it",
      name: "ship",
      projectPath: project,
      targets: ["project-agents"],
    }),
    /already exists/,
  );
});

test("setClaudeSkillEnabled edits skillOverrides in user settings", async () => {
  const settingsPath = path.join(home, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ model: "opus", skillOverrides: { other: "off" } }),
  );

  await setClaudeSkillEnabled({ enabled: false, name: "deploy" });
  let settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(settings, {
    model: "opus",
    skillOverrides: { deploy: "off", other: "off" },
  });

  await setClaudeSkillEnabled({ enabled: true, name: "deploy" });
  await setClaudeSkillEnabled({ enabled: true, name: "other" });
  settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  assert.deepEqual(settings, { model: "opus" });
});

test("setClaudeSkillEnabled refuses to clobber invalid JSON", async () => {
  const settingsPath = path.join(home, ".claude", "settings.json");
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, "{ not json");
  await assert.rejects(
    setClaudeSkillEnabled({ enabled: false, name: "deploy" }),
    /not valid JSON/,
  );
  assert.equal(await fs.readFile(settingsPath, "utf8"), "{ not json");
});
