import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import {
  applyClaudeSkillOverride,
  discoverClaudeSkills,
} from "./claude-skills.js";
import {
  parseCodexSkillsListResponse,
  scanCodexSkillDirectories,
} from "./codex-skills.js";
import { discoverCursorSkills } from "./cursor-skills.js";
import { parseOpenCodeDebugSkills } from "./opencode-skills.js";
import {
  collectProjectAncestors,
  dedupeSkillsByName,
  scanCommandRoot,
  scanSkillRoot,
} from "./scan.js";

let tempRoot;
let home;
let project;
const previousEnv = {};

const writeSkill = async (root, name, frontMatter = {}, body = "Body") => {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  const lines = ["---", `name: ${frontMatter.name ?? name}`];
  for (const [key, value] of Object.entries(frontMatter)) {
    if (key !== "name") {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---", body);
  await fs.writeFile(path.join(directory, "SKILL.md"), lines.join("\n"));
  return directory;
};

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skills-"));
  home = path.join(tempRoot, "home");
  project = path.join(tempRoot, "repo", "packages", "app");
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(path.join(tempRoot, "repo", ".git"), { recursive: true });
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

test("collectProjectAncestors walks up to the repository root", async () => {
  const ancestors = await collectProjectAncestors(project);
  assert.deepEqual(ancestors, [
    project,
    path.join(tempRoot, "repo", "packages"),
    path.join(tempRoot, "repo"),
  ]);
});

test("scanSkillRoot reads SKILL.md folders, including synced layouts, and skips trash", async () => {
  const root = path.join(home, ".claude", "skills");
  await writeSkill(root, "deploy", {
    description: "Deploy the app",
    "disable-model-invocation": "true",
  });
  await writeSkill(path.join(root, "synced", "account-1"), "pdf", {
    description: "Work with PDFs",
  });
  await writeSkill(path.join(root, ".trash", "x"), "old", {
    description: "Deleted",
  });
  await fs.mkdir(path.join(root, "deploy", "scripts"), { recursive: true });

  const skills = await scanSkillRoot({
    directory: root,
    scope: "user",
    source: "claude",
  });
  assert.deepEqual(skills.map((skill) => skill.name).sort(), ["deploy", "pdf"]);
  const deploy = skills.find((skill) => skill.name === "deploy");
  assert.equal(deploy.description, "Deploy the app");
  assert.equal(deploy.userInvocationOnly, true);
  assert.equal(deploy.scope, "user");
  assert.equal(deploy.kind, "skill");
  assert.equal(deploy.path, path.join(root, "deploy", "SKILL.md"));
});

test("scanSkillRoot returns nothing for a missing directory", async () => {
  assert.deepEqual(
    await scanSkillRoot({
      directory: path.join(home, "missing"),
      scope: "user",
      source: "claude",
    }),
    [],
  );
});

test("scanCommandRoot reads command files and uses the body as description", async () => {
  const root = path.join(home, ".claude", "commands");
  await fs.mkdir(path.join(root, "frontend"), { recursive: true });
  await fs.writeFile(
    path.join(root, "review.md"),
    "---\ndescription: Review a PR\nargument-hint: <pr-number>\n---\nReview $ARGUMENTS",
  );
  await fs.writeFile(
    path.join(root, "frontend", "component.md"),
    "# Create a component\n\nScaffold it.",
  );

  const commands = await scanCommandRoot({
    directory: root,
    scope: "user",
    source: "claude",
  });
  const byName = Object.fromEntries(commands.map((c) => [c.name, c]));
  assert.equal(byName.review.description, "Review a PR");
  assert.equal(byName.review.argumentHint, "<pr-number>");
  assert.equal(byName.review.kind, "command");
  assert.equal(byName.component.description, "Create a component");
});

test("discoverClaudeSkills merges user and project roots with user precedence and overrides", async () => {
  await writeSkill(path.join(home, ".claude", "skills"), "deploy", {
    description: "User deploy",
  });
  await writeSkill(path.join(tempRoot, "repo", ".claude", "skills"), "deploy", {
    description: "Project deploy",
  });
  await writeSkill(path.join(tempRoot, "repo", ".claude", "skills"), "test", {
    description: "Run tests",
  });
  await writeSkill(path.join(project, ".claude", "skills"), "nested", {
    description: "Nested skill",
  });
  // Codex location: Claude Code does not read it.
  await writeSkill(
    path.join(tempRoot, "repo", ".agents", "skills"),
    "codex-only",
    {
      description: "Not for Claude",
    },
  );
  await fs.mkdir(path.join(tempRoot, "repo", ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "repo", ".claude", "settings.json"),
    JSON.stringify({
      skillOverrides: { test: "off", nested: "user-invocable-only" },
    }),
  );

  const { skills } = await discoverClaudeSkills({ projectPath: project });
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ["deploy", "nested", "test"]);
  assert.equal(byName.deploy.description, "User deploy");
  assert.equal(byName.deploy.scope, "user");
  assert.equal(byName.test.enabled, false);
  assert.equal(byName.nested.userInvocationOnly, true);
  assert.equal(byName.nested.scope, "project");
});

test("applyClaudeSkillOverride leaves unknown values alone", () => {
  const skill = { enabled: true, name: "x" };
  assert.equal(applyClaudeSkillOverride(skill, undefined), skill);
  assert.equal(applyClaudeSkillOverride(skill, "on"), skill);
});

test("parseCodexSkillsListResponse picks the matching cwd entry", () => {
  const result = parseCodexSkillsListResponse(
    {
      data: [
        {
          cwd: "/other",
          errors: [],
          skills: [
            {
              name: "other",
              path: "/other/.agents/skills/other/SKILL.md",
              scope: "repo",
              enabled: true,
            },
          ],
        },
        {
          cwd: project,
          errors: [{ message: "bad SKILL.md at /x" }],
          skills: [
            {
              description: "Create skills",
              enabled: true,
              name: "skill-creator",
              path: "/sys/skill-creator/SKILL.md",
              scope: "system",
            },
            {
              enabled: false,
              interface: { displayName: "Release Helper" },
              name: "release",
              path: `${project}/.agents/skills/release/SKILL.md`,
              scope: "repo",
              shortDescription: "Cut a release",
            },
            {
              enabled: true,
              name: "plug",
              path: "/plugins/plug/SKILL.md",
              pluginId: "acme.plug",
              scope: "user",
            },
          ],
        },
      ],
    },
    project,
  );
  assert.deepEqual(result.errors, ["bad SKILL.md at /x"]);
  const byName = Object.fromEntries(result.skills.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "plug",
    "release",
    "skill-creator",
  ]);
  assert.equal(byName["skill-creator"].scope, "system");
  assert.equal(byName.release.enabled, false);
  assert.equal(byName.release.displayName, "Release Helper");
  assert.equal(byName.release.description, "Cut a release");
  assert.equal(byName.release.scope, "project");
  assert.equal(byName.plug.scope, "plugin");
});

test("scanCodexSkillDirectories reads .agents/skills up the tree plus user roots", async () => {
  await writeSkill(path.join(project, ".agents", "skills"), "local", {
    description: "Local",
  });
  await writeSkill(path.join(tempRoot, "repo", ".agents", "skills"), "root", {
    description: "Root",
  });
  await writeSkill(path.join(home, ".agents", "skills"), "user", {
    description: "User",
  });
  await writeSkill(path.join(home, ".codex", "skills"), "legacy", {
    description: "Legacy",
  });
  const { skills } = await scanCodexSkillDirectories({ projectPath: project });
  assert.deepEqual(
    skills.map((s) => `${s.name}:${s.scope}:${s.source}`),
    [
      "legacy:user:codex",
      "local:project:agents",
      "root:project:agents",
      "user:user:agents",
    ],
  );
});

test("parseOpenCodeDebugSkills classifies built-ins, user and project skills", () => {
  const skills = parseOpenCodeDebugSkills(
    `some log line\n${JSON.stringify([
      {
        name: "customize-opencode",
        description: "Built in",
        location: "<built-in>",
        content: "",
      },
      {
        name: "astro",
        description: "Astro",
        location: path.join(home, ".agents", "skills", "astro", "SKILL.md"),
        content: "",
      },
      {
        name: "local",
        description: "Local",
        location: path.join(
          project,
          ".opencode",
          "skills",
          "local",
          "SKILL.md",
        ),
        content: "",
      },
    ])}`,
    { home, projectPath: project },
  );
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(byName["customize-opencode"].scope, "system");
  assert.equal(byName["customize-opencode"].path, "");
  assert.equal(byName.astro.scope, "user");
  assert.equal(byName.astro.source, "agents");
  assert.equal(byName.local.scope, "project");
  assert.equal(byName.local.source, "opencode");
});

test("discoverCursorSkills reads native and compatibility roots", async () => {
  await writeSkill(path.join(project, ".cursor", "skills"), "design", {
    description: "Design",
  });
  await writeSkill(
    path.join(project, "apps", "web", ".cursor", "skills"),
    "nested",
    {
      description: "Nested",
    },
  );
  await writeSkill(path.join(home, ".claude", "skills"), "claude-user", {
    description: "Claude",
  });
  await writeSkill(path.join(home, ".codex", "skills"), "codex-user", {
    description: "Codex",
  });
  const { skills } = await discoverCursorSkills({ projectPath: project });
  assert.deepEqual(
    skills.map((s) => s.name),
    ["claude-user", "codex-user", "design"],
  );
});

test("dedupeSkillsByName keeps the first occurrence case-insensitively", () => {
  const result = dedupeSkillsByName([
    { name: "Deploy", scope: "user" },
    { name: "deploy", scope: "project" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].scope, "user");
});
