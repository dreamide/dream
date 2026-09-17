// English fallback keeps the new workspace usable in every locale while its
// copy is translated independently of the existing workspace messages.
export const goalMessages = {
  title: "Goals",
  newGoal: "New goal",
  editGoal: "Edit goal",
  goalActions: "Actions for {name}",
  reopenGoal: "Reopen closed goal",
  importCards: "Import Kanban cards",
  emptyTitle: "What do you want to accomplish?",
  emptyDescription:
    "Start with an outcome. Add parallel steps, review results, and iterate with feedback as the goal takes shape.",
  goalLabel: "Goal",
  titleLabel: "Title",
  descriptionLabel: "Context",
  criteriaLabel: "Acceptance criteria",
  goalPlaceholder: "What should be true when this is done?",
  criteriaPlaceholder:
    "Describe the evidence you will use to accept the result.",
  save: "Save",
  create: "Create",
  cancel: "Cancel",
  addStep: "Add next step",
  branch: "Add parallel step",
  addReview: "Add review step",
  stepActions: "Step actions",
  editStep: "Edit step",
  editStepHint:
    "Changes apply to future runs. Existing chats and run history are kept; this step and its dependents will need acceptance again.",
  removeStep: "Remove step",
  removeSteps: "Remove {count} steps",
  removeStepsChatsKept:
    "Removes this step and all dependent steps. Chats remain in your history.",
  removeStepChatsKept: "Chats remain in your history.",
  removeStepRunning:
    "Stop active runs in this step and its dependents before removing them.",
  stepTitle: "Step title",
  instructions: "Instructions",
  dependencies: "Uses results from",
  editDependenciesHint:
    "This step and its dependent steps are excluded to prevent circular dependencies.",
  reviewDependencyHint:
    "A review step must use results from the step it reviews.",
  reviewTitle: "Review: {title}",
  reviewInstructions:
    "Inspect the implementation and validate it against the goal's acceptance criteria. Report blocking issues and concrete suggestions. Do not edit files.",
  start: "Start agent",
  retry: "Run another iteration",
  revise: "Revise original step",
  feedback: "Feedback for the next iteration",
  feedbackPlaceholder: "What should the agent change or investigate?",
  acceptStep: "Accept result",
  acceptGoal: "Accept goal",
  accepted: "Accepted",
  ready: "Ready to start",
  blocked: "Waiting for inputs",
  stale: "Inputs changed · rerun needed",
  queued: "Queued",
  running: "Working",
  waiting: "Needs your input",
  finished: "Ready to inspect",
  failed: "Failed",
  interrupted: "Interrupted",
  work: "Work",
  review: "Review",
  runs: "Run history",
  runNumber: "Run {number}",
  noRuns: "No runs yet. Start an agent when this step is ready.",
  noOutput:
    "No final response yet. Open the chat to see activity or respond to the agent.",
  openChat: "Open chat",
  chatUnavailable: "Chat no longer available",
  selectStep: "Select a step to inspect its runs and direct the next action.",
  goalProgress: "{accepted} of {total} results accepted",
  manualLoop:
    "Review → feedback → another iteration. You decide when the goal is met.",
  sharedWorkspace:
    "Runs use this project's workspace. Give concurrent steps distinct scopes.",
  startFailed:
    "This step could not start. Check its dependencies and any active run.",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  resetZoom: "Reset zoom",
  graphLabel: "Goal execution graph",
  feedbackEdge: "Feedback",
  editCriteriaHint:
    "Changing the goal clears previous acceptances so results can be reviewed against the new criteria.",
};

export const goalWorkspaceLabels = {
  de: "Ziele",
  en: "Goals",
  es: "Objetivos",
  fr: "Objectifs",
  it: "Obiettivi",
  ja: "ゴール",
  ko: "목표",
  pt: "Objetivos",
  vi: "Mục tiêu",
  "zh-Hans": "目标",
  "zh-Hant": "目標",
};
