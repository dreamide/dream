import { describe, expect, test } from "vitest";
import type { ProjectReference, ProviderSkill } from "@/types/ide";
import {
  applyComposerEdit,
  buildProjectReferenceIndex,
  type ComposerCatalog,
  type ComposerState,
  composerNeedsSkillCatalog,
  EMPTY_COMPOSER_STATE,
  findSkillMentions,
  getActiveSkillToken,
  handleComposerKey,
  hasPossibleSkillMention,
  MENTION_ICON_SLOT,
  readComposerDraft,
  searchProviderSkills,
  serializeComposerDraft,
} from "./composer-draft";

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

const file = (path: string): ProjectReference =>
  buildProjectReferenceIndex([path]).find(
    (item) => item.kind === "file",
  ) as ProjectReference;

const catalog = (
  overrides: Partial<ComposerCatalog> = {},
): ComposerCatalog => ({
  projectReferences: buildProjectReferenceIndex([
    "src/app.ts",
    "src/lib/utils.ts",
    "README.md",
  ]),
  skills: [
    skill({ name: "deploy" }),
    skill({ displayName: "PDF", name: "pdf" }),
    skill({ displayName: "PDF Tools", name: "pdf-tools" }),
  ],
  skillsSupported: true,
  ...overrides,
});

/** Types `text` one character at a time, as the textarea would report it. */
const type = (
  state: ComposerState,
  text: string,
  context = catalog(),
): ComposerState => {
  let next = state;
  for (const character of text) {
    const value = next.text + character;
    next = applyComposerEdit(
      next,
      { caret: value.length, text: value, type: "input" },
      context,
    ).state;
  }
  return next;
};

const key = (
  state: ComposerState,
  name: string,
  context = catalog(),
  selection?: { end: number; start: number },
) =>
  handleComposerKey(
    state,
    {
      key: name,
      selectionEnd: selection?.end ?? state.text.length,
      selectionStart: selection?.start ?? state.text.length,
    },
    context,
  );

const press = (state: ComposerState, name: string, context = catalog()) => {
  const result = key(state, name, context);
  if (!result) {
    throw new Error(`${name} was not handled`);
  }
  return result.state;
};

describe("typing and picking a skill", () => {
  test("type $pd, pick it, submit sends $name and the skill", () => {
    let state = type(EMPTY_COMPOSER_STATE, "use $pd");
    const menu = readComposerDraft(state, catalog()).menu;
    expect(menu?.kind).toBe("skill");
    expect(menu?.items.map((item) => item.name)).toEqual(["pdf", "pdf-tools"]);

    state = press(state, "ArrowDown");
    state = press(state, "Enter");
    expect(state.text).toBe(`use ${MENTION_ICON_SLOT}PDF Tools `);
    state = type(state, "now");

    expect(serializeComposerDraft(state, catalog().skills)).toEqual({
      references: [],
      skills: ["pdf-tools"],
      text: "use $pdf-tools now",
    });
  });

  test("a typed $name is sent as written and reported as a skill", () => {
    const state = type(EMPTY_COMPOSER_STATE, "run $deploy please");
    expect(serializeComposerDraft(state, catalog().skills)).toEqual({
      references: [],
      skills: ["deploy"],
      text: "run $deploy please",
    });
  });

  test("the longest picked label wins over a shorter one it contains", () => {
    const text = `${MENTION_ICON_SLOT}PDF Tools and ${MENTION_ICON_SLOT}PDF`;
    const segments = readComposerDraft(
      { references: [], text, token: null },
      catalog(),
    ).segments.filter((segment) => segment.kind === "picked-skill");
    expect(
      segments.map((segment) =>
        segment.kind === "picked-skill" ? segment.skill.name : null,
      ),
    ).toEqual(["pdf-tools", "pdf"]);
  });

  test("skills sharing a label are picked under their unique names", () => {
    const context = catalog({
      skills: [
        skill({ displayName: "Review", name: "review-a", source: "claude" }),
        skill({ displayName: "Review", name: "review-b", source: "codex" }),
      ],
    });
    let state = type(EMPTY_COMPOSER_STATE, "$rev", context);
    state = press(state, "Enter", context);
    expect(state.text).toBe(`${MENTION_ICON_SLOT}review-a `);
  });

  test("a provider without skills offers no menu and finds no mentions", () => {
    const context = catalog({ skillsSupported: false });
    const state = type(EMPTY_COMPOSER_STATE, "$dep", context);
    expect(readComposerDraft(state, context).menu).toBeNull();
    expect(
      serializeComposerDraft(state, [], { skillsSupported: false }).skills,
    ).toEqual([]);
  });
});

describe("picking a file", () => {
  test("type @app, pick it, submit sends @path and the reference", () => {
    let state = type(EMPTY_COMPOSER_STATE, "look at @app");
    expect(readComposerDraft(state, catalog()).menu?.kind).toBe("reference");

    state = press(state, "Tab");
    expect(state.text).toBe(`look at ${MENTION_ICON_SLOT}app.ts `);
    expect(state.references.map((reference) => reference.path)).toEqual([
      "src/app.ts",
    ]);

    expect(serializeComposerDraft(state, [])).toEqual({
      references: state.references,
      skills: [],
      text: "look at @src/app.ts ",
    });
  });

  test("a mention touching a word is padded so the path stays separate", () => {
    const reference = file("src/app.ts");
    expect(
      serializeComposerDraft(
        { references: [reference], text: `x${MENTION_ICON_SLOT}app.ts` },
        [],
      ).text,
    ).toBe("x @src/app.ts");
  });

  test("the menu hides once the token names a picked file", () => {
    const reference = file("src/app.ts");
    const state: ComposerState = {
      references: [reference],
      text: "@app.ts",
      token: {
        highlighted: 0,
        kind: "reference",
        token: { end: 7, query: "app.ts", start: 0 },
      },
    };
    expect(readComposerDraft(state, catalog()).menu).toBeNull();
  });

  test("editing a file mention's text drops the file", () => {
    let state = type(EMPTY_COMPOSER_STATE, "@app");
    state = press(state, "Enter");
    const broken = state.text.replace("app.ts", "app.t");
    state = applyComposerEdit(
      state,
      { caret: broken.length, text: broken, type: "input" },
      catalog(),
    ).state;
    expect(state.references).toEqual([]);
  });
});

describe("deleting mentions", () => {
  const withFile = () => {
    let state = type(EMPTY_COMPOSER_STATE, "see @app");
    state = press(state, "Enter");
    return type(state, "now");
  };

  test("backspace inside a mention deletes the whole mention", () => {
    const state = withFile();
    const end = `see ${MENTION_ICON_SLOT}app.ts`.length;
    const result = key(state, "Backspace", catalog(), { end, start: end });
    expect(result?.state.text).toBe("see now");
    expect(result?.state.references).toEqual([]);
    expect(result?.caret).toBe(4);
  });

  test("delete before a mention deletes it too", () => {
    const state = withFile();
    const at = "see ".length;
    const result = key(state, "Delete", catalog(), { end: at, start: at });
    expect(result?.state.text).toBe("see now");
  });

  test("a selection across a mention widens to the whole mention", () => {
    const state = withFile();
    const result = key(state, "Backspace", catalog(), { end: 6, start: 1 });
    expect(result?.state.text).toBe("s now");
  });

  test("a picked skill deletes as one unit; a typed $name does not", () => {
    let picked = type(EMPTY_COMPOSER_STATE, "$dep");
    picked = press(picked, "Enter");
    expect(
      key(picked, "Backspace", catalog(), {
        end: picked.text.length - 1,
        start: picked.text.length - 1,
      })?.state.text,
    ).toBe("");

    const typed = type(EMPTY_COMPOSER_STATE, "$deploy");
    expect(key(typed, "Backspace")).toBeNull();
  });

  test("backspace in plain prose is left to the textarea", () => {
    expect(key(withFile(), "Backspace")).toBeNull();
  });
});

describe("keys", () => {
  test("PageUp and PageDown are swallowed", () => {
    expect(key(EMPTY_COMPOSER_STATE, "PageUp")).not.toBeNull();
    expect(key(EMPTY_COMPOSER_STATE, "PageDown")).not.toBeNull();
  });

  test("arrows wrap around the menu", () => {
    let state = type(EMPTY_COMPOSER_STATE, "$pd");
    state = press(state, "ArrowUp");
    expect(readComposerDraft(state, catalog()).menu?.highlighted).toBe(1);
    state = press(state, "ArrowDown");
    expect(readComposerDraft(state, catalog()).menu?.highlighted).toBe(0);
  });

  test("Escape closes the menu and keeps the text", () => {
    const state = press(type(EMPTY_COMPOSER_STATE, "@sr"), "Escape");
    expect(state.text).toBe("@sr");
    expect(readComposerDraft(state, catalog()).menu).toBeNull();
    expect(key(state, "Escape")).toBeNull();
  });

  test("Enter with no menu is the caller's (send)", () => {
    expect(key(type(EMPTY_COMPOSER_STATE, "hello"), "Enter")).toBeNull();
  });
});

describe("serializeComposerDraft", () => {
  test("already-serialized text passes through, recovering its skills", () => {
    const sent = serializeComposerDraft(
      { references: [], text: "use $deploy on @src/app.ts" },
      catalog().skills,
    );
    expect(sent.text).toBe("use $deploy on @src/app.ts");
    expect(sent.skills).toEqual(["deploy"]);
  });

  test("files and skills mixed in one draft", () => {
    const reference = file("src/app.ts");
    const text = `${MENTION_ICON_SLOT}PDF on ${MENTION_ICON_SLOT}app.ts, then $deploy`;
    expect(
      serializeComposerDraft(
        { references: [reference], text },
        catalog().skills,
      ),
    ).toEqual({
      references: [reference],
      skills: ["pdf", "deploy"],
      text: "$pdf on @src/app.ts, then $deploy",
    });
  });
});

describe("composerNeedsSkillCatalog", () => {
  test("asks for the catalog only when the draft could mention a skill", () => {
    expect(composerNeedsSkillCatalog(EMPTY_COMPOSER_STATE, true)).toBe(false);
    expect(
      composerNeedsSkillCatalog(type(EMPTY_COMPOSER_STATE, "$"), true),
    ).toBe(true);
    expect(
      composerNeedsSkillCatalog(
        { references: [], text: `${MENTION_ICON_SLOT}PDF`, token: null },
        true,
      ),
    ).toBe(true);
    expect(
      composerNeedsSkillCatalog(
        {
          references: [file("src/app.ts")],
          text: `${MENTION_ICON_SLOT}app.ts`,
          token: null,
        },
        true,
      ),
    ).toBe(false);
    expect(
      composerNeedsSkillCatalog(type(EMPTY_COMPOSER_STATE, "$"), false),
    ).toBe(false);
  });
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
      "debug-help",
      "deploy",
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

describe("buildProjectReferenceIndex", () => {
  test("lists folders above files, then files, each by path", () => {
    expect(
      buildProjectReferenceIndex(["src\\lib\\a.ts", "b.ts"]).map((item) => [
        item.kind,
        item.path,
        item.parentPath,
      ]),
    ).toEqual([
      ["folder", "src", ""],
      ["folder", "src/lib", "src"],
      ["file", "b.ts", ""],
      ["file", "src/lib/a.ts", "src/lib"],
    ]);
  });
});
