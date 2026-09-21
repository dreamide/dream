import assert from "node:assert/strict";
import { test } from "vitest";
import type { TaskStepRun } from "@/types/ide";
import {
  DEFAULT_TASK_PROMPTS,
  getEarlierTaskRunSteps,
  getNextTaskStep,
  getTaskReviewVerdict,
  getTaskStepPrompt,
  renderTaskPrompt,
  TASK_PROMPT_VARIABLES,
  TASK_RUN_STEP_IDS,
} from "./task-defaults";

const run = (
  step: TaskStepRun["step"],
  output: string | null,
): TaskStepRun => ({
  chatId: null,
  commitError: null,
  feedback: null,
  finishedAt: "now",
  id: `${step}-${output}`,
  output,
  startedAt: "now",
  step,
});

const task = {
  baseRef: "main",
  branch: "task/task",
  description: "Do the thing",
  runs: [] as TaskStepRun[],
  title: "Task",
};

test("steps advance down the line and merge is last", () => {
  assert.equal(getNextTaskStep("backlog"), "plan");
  assert.equal(getNextTaskStep("plan"), "build");
  assert.equal(getNextTaskStep("review"), "merge");
  assert.equal(getNextTaskStep("merge"), null);
  assert.deepEqual(getEarlierTaskRunSteps("review"), ["plan", "build"]);
  assert.deepEqual(getEarlierTaskRunSteps("plan"), []);
});

test("default prompts only use known variables", () => {
  for (const step of TASK_RUN_STEP_IDS) {
    const used = [...DEFAULT_TASK_PROMPTS[step].matchAll(/\{\{([\w.]+)\}\}/g)];
    for (const match of used) {
      assert.ok(
        (TASK_PROMPT_VARIABLES as readonly string[]).includes(
          match[1] as string,
        ),
        `${step}: ${match[1]}`,
      );
    }
  }
});

test("a blank custom prompt falls back to the default", () => {
  assert.equal(
    getTaskStepPrompt("plan", { prompt: "  " }),
    DEFAULT_TASK_PROMPTS.plan,
  );
  assert.equal(getTaskStepPrompt("plan", { prompt: "Mine" }), "Mine");
});

test("renders task, branch, and step outputs", () => {
  const planRun = run("plan", "The plan");
  const buildRun = run("build", "Built it");
  const text = renderTaskPrompt({
    previousRun: buildRun,
    task: { ...task, runs: [planRun, buildRun] },
    template: DEFAULT_TASK_PROMPTS.review,
  });

  assert.match(text, /# Task/);
  assert.match(text, /task\/task against main/);
  assert.match(text, /The plan/);
  assert.match(text, /Built it/);
  assert.doesNotMatch(text, /\{\{/);
  assert.doesNotMatch(text, /Handoff from/);
});

test("the latest output of a step wins", () => {
  const text = renderTaskPrompt({
    task: { ...task, runs: [run("plan", "Old plan"), run("plan", "New plan")] },
    template: "{{plan.output}}",
  });
  assert.equal(text, "New plan");
});

test("unknown and empty variables render as nothing", () => {
  assert.equal(
    renderTaskPrompt({
      task,
      template: "A {{nope}} B\n\n\n\n{{review.output}}\n\n\nC",
    }),
    "A  B\n\nC",
  );
});

test("a custom prompt that drops the handoff still receives it", () => {
  const text = renderTaskPrompt({
    feedback: "Fix the bug",
    previousRun: run("review", "CHANGES REQUESTED"),
    task,
    template: "Just do {{task.title}}",
  });

  assert.match(text, /^Just do Task/);
  assert.match(text, /## Handoff from review\nCHANGES REQUESTED/);
  assert.match(text, /## Feedback to address\nFix the bug/);
});

test("missing git details fall back to readable wording", () => {
  assert.equal(
    renderTaskPrompt({
      task: { ...task, baseRef: null, branch: null },
      template: "{{branch}} -> {{baseRef}}",
    }),
    "the current branch -> the base branch",
  );
});

test("reads the review verdict line", () => {
  assert.equal(
    getTaskReviewVerdict("Looks good.\n\nAPPROVE\n1. nit at a.ts:3"),
    "approve",
  );
  assert.equal(
    getTaskReviewVerdict("**Verdict: CHANGES REQUESTED**\n1. bug at a.ts:3"),
    "changes",
  );
  assert.equal(
    getTaskReviewVerdict("## Verdict\nCHANGES_REQUESTED"),
    "changes",
  );
});

test("requested changes win over an approve mentioned in the findings", () => {
  assert.equal(
    getTaskReviewVerdict(
      "I cannot APPROVE this yet.\nOverall: changes requested before merge.",
    ),
    "changes",
  );
});

test("gives no verdict when the reviewer did not state one", () => {
  assert.equal(getTaskReviewVerdict(null), null);
  assert.equal(getTaskReviewVerdict("   "), null);
  assert.equal(getTaskReviewVerdict("Approve of the naming overall."), null);
});
