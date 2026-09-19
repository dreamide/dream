import assert from "node:assert/strict";
import { test } from "vitest";
import type { PipelineStepRun } from "@/types/ide";
import {
  DEFAULT_PIPELINE_PROMPTS,
  getEarlierPipelineRunSteps,
  getNextPipelineStep,
  getPipelineStepPrompt,
  PIPELINE_PROMPT_VARIABLES,
  PIPELINE_RUN_STEP_IDS,
  renderPipelinePrompt,
} from "./pipeline-defaults";

const run = (
  step: PipelineStepRun["step"],
  output: string | null,
): PipelineStepRun => ({
  chatId: null,
  feedback: null,
  finishedAt: "now",
  id: `${step}-${output}`,
  output,
  startedAt: "now",
  step,
});

const task = {
  baseRef: "main",
  branch: "pipeline/task",
  description: "Do the thing",
  runs: [] as PipelineStepRun[],
  title: "Task",
};

test("steps advance down the line and merge is last", () => {
  assert.equal(getNextPipelineStep("backlog"), "plan");
  assert.equal(getNextPipelineStep("plan"), "build");
  assert.equal(getNextPipelineStep("review"), "merge");
  assert.equal(getNextPipelineStep("merge"), null);
  assert.deepEqual(getEarlierPipelineRunSteps("review"), ["plan", "build"]);
  assert.deepEqual(getEarlierPipelineRunSteps("plan"), []);
});

test("default prompts only use known variables", () => {
  for (const step of PIPELINE_RUN_STEP_IDS) {
    const used = [
      ...DEFAULT_PIPELINE_PROMPTS[step].matchAll(/\{\{([\w.]+)\}\}/g),
    ];
    for (const match of used) {
      assert.ok(
        (PIPELINE_PROMPT_VARIABLES as readonly string[]).includes(
          match[1] as string,
        ),
        `${step}: ${match[1]}`,
      );
    }
  }
});

test("a blank custom prompt falls back to the default", () => {
  assert.equal(
    getPipelineStepPrompt("plan", { prompt: "  " }),
    DEFAULT_PIPELINE_PROMPTS.plan,
  );
  assert.equal(getPipelineStepPrompt("plan", { prompt: "Mine" }), "Mine");
});

test("renders task, branch, and step outputs", () => {
  const planRun = run("plan", "The plan");
  const buildRun = run("build", "Built it");
  const text = renderPipelinePrompt({
    previousRun: buildRun,
    task: { ...task, runs: [planRun, buildRun] },
    template: DEFAULT_PIPELINE_PROMPTS.review,
  });

  assert.match(text, /# Task/);
  assert.match(text, /pipeline\/task against main/);
  assert.match(text, /The plan/);
  assert.match(text, /Built it/);
  assert.doesNotMatch(text, /\{\{/);
  assert.doesNotMatch(text, /Handoff from/);
});

test("the latest output of a step wins", () => {
  const text = renderPipelinePrompt({
    task: { ...task, runs: [run("plan", "Old plan"), run("plan", "New plan")] },
    template: "{{plan.output}}",
  });
  assert.equal(text, "New plan");
});

test("unknown and empty variables render as nothing", () => {
  assert.equal(
    renderPipelinePrompt({
      task,
      template: "A {{nope}} B\n\n\n\n{{review.output}}\n\n\nC",
    }),
    "A  B\n\nC",
  );
});

test("a custom prompt that drops the handoff still receives it", () => {
  const text = renderPipelinePrompt({
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
    renderPipelinePrompt({
      task: { ...task, baseRef: null, branch: null },
      template: "{{branch}} -> {{baseRef}}",
    }),
    "the current branch -> the base branch",
  );
});
