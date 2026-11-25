import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { discoverAntigravitySkills } from "./antigravity-skills.js";
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
  for (const key of [
    "DREAM_SKILLS_HOME",
    "CLAUDE_CONFIG_DIR",
    "ANTIGRAVITY_CONFIG_DIR",
    "ANTIGRAVITY_CLI_DIR",
    "GEMINI_CONFIG_DIR",
    "GEMINI_CLI_DIR",
  ]) {
    previousEnv[key] = process.env[key];
  }
  process.env.DREAM_SKILLS_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = "";
  process.env.ANTIGRAVITY_CONFIG_DIR = "";
  process.env.ANTIGRAVITY_CLI_DIR = "";
  process.env.GEMINI_CONFIG_DIR = "";
  process.env.GEMINI_CLI_DIR = "";
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

test("discoverAntigravitySkills discovers project skills in .gemini/skills and .agents/skills up ancestor tree", async () => {
  const projectGemini = path.join(project, ".gemini", "skills");
  const repoAgents = path.join(tempRoot, "repo", ".agents", "skills");
  await writeSkill(projectGemini, "project-gemini-skill", {
    description: "Project Gemini",
  });
  await writeSkill(repoAgents, "repo-agents-skill", {
    description: "Repo Agents",
  });

  const result = await discoverAntigravitySkills({ projectPath: project });
  assert.equal(result.errors.length, 0);
  const geminiSkill = result.skills.find(
    (s) => s.name === "project-gemini-skill",
  );
  assert.ok(geminiSkill);
  assert.equal(geminiSkill.scope, "project");
  assert.equal(geminiSkill.source, "gemini");

  const agentsSkill = result.skills.find((s) => s.name === "repo-agents-skill");
  assert.ok(agentsSkill);
  assert.equal(agentsSkill.scope, "project");
  assert.equal(agentsSkill.source, "agents");
});

test("discoverAntigravitySkills discovers user skills across config, cli, and agents roots", async () => {
  const configSkills = path.join(home, ".gemini", "config", "skills");
  const cliSkills = path.join(home, ".gemini", "antigravity-cli", "skills");
  const agentsSkills = path.join(home, ".agents", "skills");
  await writeSkill(configSkills, "user-config-skill", {
    description: "User config",
  });
  await writeSkill(cliSkills, "user-cli-skill", {
    description: "User CLI",
  });
  await writeSkill(agentsSkills, "user-agents-skill", {
    description: "User agents",
  });

  const result = await discoverAntigravitySkills();
  assert.equal(result.errors.length, 0);

  const configSkill = result.skills.find((s) => s.name === "user-config-skill");
  assert.ok(configSkill);
  assert.equal(configSkill.scope, "user");
  assert.equal(configSkill.source, "gemini");

  const cliSkill = result.skills.find((s) => s.name === "user-cli-skill");
  assert.ok(cliSkill);
  assert.equal(cliSkill.scope, "user");
  assert.equal(cliSkill.source, "gemini");

  const agentsSkill = result.skills.find((s) => s.name === "user-agents-skill");
  assert.ok(agentsSkill);
  assert.equal(agentsSkill.scope, "user");
  assert.equal(agentsSkill.source, "agents");
});

test("discoverAntigravitySkills discovers plugin skills with pluginId and respects disabled state", async () => {
  const pluginsDir = path.join(home, ".gemini", "config", "plugins");
  const activePluginDir = path.join(pluginsDir, "active-plugin");
  const disabledPluginDir = path.join(pluginsDir, "disabled-plugin");

  await writeSkill(path.join(activePluginDir, "skills"), "plugin-skill-1", {
    description: "Active",
  });
  await fs.writeFile(
    path.join(activePluginDir, "plugin.json"),
    JSON.stringify({ name: "active-plugin" }),
  );

  await writeSkill(path.join(disabledPluginDir, "skills"), "plugin-skill-2", {
    description: "Disabled",
  });
  await fs.writeFile(
    path.join(disabledPluginDir, "plugin.json"),
    JSON.stringify({ disabled: true, name: "disabled-plugin" }),
  );

  const result = await discoverAntigravitySkills();
  assert.equal(result.errors.length, 0);

  const skill1 = result.skills.find((s) => s.name === "plugin-skill-1");
  assert.ok(skill1);
  assert.equal(skill1.scope, "plugin");
  assert.equal(skill1.pluginId, "active-plugin");
  assert.equal(skill1.enabled, true);

  const skill2 = result.skills.find((s) => s.name === "plugin-skill-2");
  assert.ok(skill2);
  assert.equal(skill2.scope, "plugin");
  assert.equal(skill2.pluginId, "disabled-plugin");
  assert.equal(skill2.enabled, false);
});

test("discoverAntigravitySkills discovers system skills from builtin directory", async () => {
  const builtinSkills = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "builtin",
    "skills",
  );
  await writeSkill(builtinSkills, "system-skill", {
    description: "Builtin system skill",
  });

  const result = await discoverAntigravitySkills();
  assert.equal(result.errors.length, 0);

  const skill = result.skills.find((s) => s.name === "system-skill");
  assert.ok(skill);
  assert.equal(skill.scope, "system");
  assert.equal(skill.source, "gemini");
});

test("discoverAntigravitySkills enforces precedence order: project > user > plugin > system", async () => {
  const projectSkills = path.join(project, ".gemini", "skills");
  const userSkills = path.join(home, ".gemini", "config", "skills");
  const pluginSkills = path.join(
    home,
    ".gemini",
    "config",
    "plugins",
    "some-plugin",
    "skills",
  );
  const systemSkills = path.join(
    home,
    ".gemini",
    "antigravity-cli",
    "builtin",
    "skills",
  );

  await writeSkill(projectSkills, "shared-skill", {
    description: "Project version",
  });
  await writeSkill(userSkills, "shared-skill", {
    description: "User version",
  });
  await writeSkill(pluginSkills, "shared-skill", {
    description: "Plugin version",
  });
  await writeSkill(systemSkills, "shared-skill", {
    description: "System version",
  });

  const resultProject = await discoverAntigravitySkills({
    projectPath: project,
  });
  const foundProject = resultProject.skills.find(
    (s) => s.name === "shared-skill",
  );
  assert.ok(foundProject);
  assert.equal(foundProject.scope, "project");
  assert.equal(foundProject.description, "Project version");

  const resultUser = await discoverAntigravitySkills();
  const foundUser = resultUser.skills.find((s) => s.name === "shared-skill");
  assert.ok(foundUser);
  assert.equal(foundUser.scope, "user");
  assert.equal(foundUser.description, "User version");
});
