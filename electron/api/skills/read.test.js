import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { invalidateSkillCache } from "./index.js";
import { readSkillFile } from "./read.js";

let home;
const previousEnv = {};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "dream-skill-read-"));
  for (const key of ["DREAM_SKILLS_HOME", "CLAUDE_CONFIG_DIR"]) {
    previousEnv[key] = process.env[key];
  }
  process.env.DREAM_SKILLS_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = "";
  invalidateSkillCache();
});

afterEach(async () => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  invalidateSkillCache();
  await fs.rm(home, { force: true, recursive: true });
});

test("readSkillFile returns the body of a discovered skill and refuses others", async () => {
  const directory = path.join(home, ".claude", "skills", "deploy");
  await fs.mkdir(directory, { recursive: true });
  const skillPath = path.join(directory, "SKILL.md");
  await fs.writeFile(
    skillPath,
    "---\nname: deploy\ndescription: Ship\n---\n# Deploy\n\nSteps.\n",
  );
  await fs.writeFile(path.join(home, "secret.md"), "nope");

  const result = await readSkillFile({ provider: "anthropic", skillPath });
  assert.equal(result.body.trim(), "# Deploy\n\nSteps.");
  assert.equal(result.attributes.description, "Ship");

  await assert.rejects(
    readSkillFile({
      provider: "anthropic",
      skillPath: path.join(home, "secret.md"),
    }),
    /not one of this provider's skills/,
  );
});
