export type GoalRunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "finished"
  | "failed"
  | "interrupted";

export interface GoalRun {
  id: string;
  chatId: string | null;
  createdAt: string;
  status: GoalRunStatus;
  feedback: string;
  output: string;
  inputRunIds: Record<string, string>;
  revision: number;
}

export interface GoalStep {
  id: string;
  title: string;
  instructions: string;
  kind: "work" | "review";
  dependsOn: string[];
  reviewOf: string | null;
  acceptedRunId: string | null;
  runs: GoalRun[];
}

export interface Goal {
  id: string;
  title: string;
  description: string;
  criteria: string;
  createdAt: string;
  acceptedAt: string | null;
  steps: GoalStep[];
}
