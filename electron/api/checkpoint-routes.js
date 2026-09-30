import {
  checkpointChangesRequestSchema,
  checkpointDeleteChatsRequestSchema,
  checkpointDiffRequestSchema,
  checkpointRestoreRequestSchema,
} from "./checkpoints/schemas.js";
import {
  deleteChatCheckpoints,
  getCheckpointFileDiff,
  listCheckpointChanges,
  restoreCheckpointFiles,
} from "./checkpoints/service.js";
import { postProjectRoute } from "./shared/json-route.js";

const CHECKPOINT_ERROR = { errorMessage: "Checkpoint request failed." };

// Cleanup runs for projects whose directory may already be gone.
const CLEANUP_OPTIONS = { ...CHECKPOINT_ERROR, requireProjectDirectory: false };

export const registerCheckpointRoutes = (app) => {
  postProjectRoute(
    app,
    "/api/checkpoint-changes",
    checkpointChangesRequestSchema,
    listCheckpointChanges,
    CHECKPOINT_ERROR,
  );

  postProjectRoute(
    app,
    "/api/checkpoint-diff",
    checkpointDiffRequestSchema,
    getCheckpointFileDiff,
    CHECKPOINT_ERROR,
  );

  postProjectRoute(
    app,
    "/api/checkpoint-restore",
    checkpointRestoreRequestSchema,
    restoreCheckpointFiles,
    CHECKPOINT_ERROR,
  );

  postProjectRoute(
    app,
    "/api/checkpoint-delete-chats",
    checkpointDeleteChatsRequestSchema,
    async ({ chatIds, projectPath }) => {
      let deletedRefs = 0;
      for (const chatId of chatIds) {
        deletedRefs += await deleteChatCheckpoints({ chatId, projectPath });
      }
      return { deletedRefs };
    },
    CLEANUP_OPTIONS,
  );
};
