import { describe, expect, test } from "vitest";
import type { ProviderSkill } from "@/types/ide";
import {
  findSkillMentions,
  getActiveSkillToken,
  hasPossibleSkillMention,
  searchProviderSkills,
} from "./provider-skills";

const skill = (overrides: Partial<ProviderSkill>): ProviderSkill => ({
  description: "",
  directory: "",
  enabled: true,
  kind: "skill",
  name: "deploy",
  path: "",
  provider: "anthropic",
  scope: "user",
  source: "claude",
  ...overrides,
});

describe("getActiveSkillToken", () => {
  test("detects a $ token at the caret", () => {
    expect(getActiveSkillToken("run $dep", 8)).toEqual({
      end: 8,
      query: "dep",
      start: 4,
    });
    expect(getActiveSkillToken("$", 1)).toEqual({
      end: 1,
      query: "",
      start: 0,
    });
  });

  test("ignores currency amounts and mid-word dollars", () => {
    expect(getActiveSkillToken("costs $50", 9)).toBeNull();
    expect(getActiveSkillToken("a$b", 3)).toBeNull();
  });

  test("ignores tokens the caret has left", () => {
    expect(getActiveSkillToken("$deploy now", 11)).toBeNull();
  });
});

describe("findSkillMentions", () => {
  const skills = [
    skill({ name: "deploy" }),
    skill({ name: "pdf-tools", scope: "project" }),
  ];

  test("finds known mentions only", () => {
    expect(
      findSkillMentions(
        "use $deploy and $pdf-tools, not $unknown or $50",
        skills,
      ).map((range) => [range.name, range.start, range.end]),
    ).toEqual([
      ["deploy", 4, 11],
      ["pdf-tools", 16, 26],
    ]);
  });

  test("matches case-insensitively at line start and after brackets", () => {
    expect(findSkillMentions("$Deploy\n($deploy)", skills)).toHaveLength(2);
  });

  test("hasPossibleSkillMention", () => {
    expect(hasPossibleSkillMention("hello $world")).toBe(true);
    expect(hasPossibleSkillMention("hello $5")).toBe(false);
    expect(hasPossibleSkillMention("hello")).toBe(false);
  });
});

describe("searchProviderSkills", () => {
  const skills = [
    skill({ name: "deploy", scope: "project" }),
    skill({ name: "debug-help", description: "Debug a failing test" }),
    skill({ name: "hidden", userInvocable: false }),
    skill({ enabled: false, name: "disabled" }),
    skill({ displayName: "Release Helper", name: "rel" }),
  ];

  test("hides disabled and non-user-invocable skills", () => {
    expect(searchProviderSkills(skills, "").map((s) => s.name)).toEqual([
      "deploy",
      "debug-help",
      "rel",
    ]);
  });

  test("ranks name prefix over display name and description", () => {
    expect(searchProviderSkills(skills, "de").map((s) => s.name)).toEqual([
      "debug-help",
      "deploy",
    ]);
    expect(searchProviderSkills(skills, "release").map((s) => s.name)).toEqual([
      "rel",
    ]);
    expect(searchProviderSkills(skills, "failing").map((s) => s.name)).toEqual([
      "debug-help",
    ]);
  });
});
