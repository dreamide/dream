import { describe, expect, it } from "vitest";
import { renderTaskPrompt } from "./task-prompt";

const project = {
  name: "dream",
  path: "/work/dream",
  worktree: null,
};

describe("renderTaskPrompt", () => {
  it("fills project variables", () => {
    expect(
      renderTaskPrompt({
        branch: "feature/x",
        project,
        prompt: "Review {{ project.name }} at {{project.path}} on {{branch}}",
      }),
    ).toBe("Review dream at /work/dream on feature/x");
  });

  it("falls back to the worktree's branch, then to a description", () => {
    const worktreeProject = {
      ...project,
      worktree: {
        baseRef: "main",
        branch: "task-branch",
        createdAt: "2026-01-01T00:00:00.000Z",
        kind: "worktree" as const,
        mainWorktreePath: "/work/dream",
        managed: true,
        parentProjectId: null,
        repoRoot: "/work/dream",
      },
    };

    expect(
      renderTaskPrompt({
        project: worktreeProject,
        prompt: "{{branch}} into {{baseRef}}",
      }),
    ).toBe("task-branch into main");
    expect(
      renderTaskPrompt({ project, prompt: "{{branch}} into {{baseRef}}" }),
    ).toBe("the current branch into the base branch");
  });

  it("leaves unknown placeholders as written", () => {
    expect(
      renderTaskPrompt({ project, prompt: "Keep {{user.name}} as is" }),
    ).toBe("Keep {{user.name}} as is");
  });
});
