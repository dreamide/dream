import { HOST_ROUTES } from "../shared/host-routes.js";
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
import { registerProjectRoute } from "./shared/json-route.js";

const CHECKPOINT_ERROR = { errorMessage: "Checkpoint request failed." };

// Cleanup runs for projects whose directory may already be gone.
const CLEANUP_OPTIONS = { ...CHECKPOINT_ERROR, requireProjectDirectory: false };

export const registerCheckpointRoutes = (app) => {
  registerProjectRoute(
    app,
    HOST_ROUTES.checkpointChanges,
    checkpointChangesRequestSchema,
    listCheckpointChanges,
    CHECKPOINT_ERROR,
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.checkpointDiff,
    checkpointDiffRequestSchema,
    getCheckpointFileDiff,
    CHECKPOINT_ERROR,
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.checkpointRestore,
    checkpointRestoreRequestSchema,
    restoreCheckpointFiles,
    CHECKPOINT_ERROR,
  );

  registerProjectRoute(
    app,
    HOST_ROUTES.checkpointDeleteChats,
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
