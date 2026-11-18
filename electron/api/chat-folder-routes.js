// `POST /api/chat-folders`: creates the chat folder of a new standalone
// project on this host (host/chat-folders.js).
import { z } from "zod";
import { ChatFolderError, createChatFolder } from "../host/chat-folders.js";
import { HOST_ROUTES } from "../shared/host-routes.js";
import { handleJsonRoute, RouteError } from "./shared/json-route.js";
import { registerRoute } from "./shared/register-route.js";

export const chatFolderCreateRequestSchema = z.object({
  /** The new Project's id; its start names the folder. */
  projectId: z
    .string()
    .regex(/^[A-Za-z0-9-]{8,}$/, "projectId must be a Project id."),
});

/**
 * @param {import("hono").Hono} app
 * @param {{ home?: string, findGitTopLevel?: (folder: string) => Promise<string | null> }} [options]
 */
export function registerChatFolderRoutes(app, options = {}) {
  registerRoute(app, HOST_ROUTES.createChatFolder, (c) =>
    handleJsonRoute(
      c,
      chatFolderCreateRequestSchema,
      async ({ projectId }) => {
        try {
          return await createChatFolder({ ...options, projectId });
        } catch (error) {
          if (error instanceof ChatFolderError) {
            throw new RouteError(error.message, 409);
          }
          throw error;
        }
      },
      { errorMessage: "Unable to create a chat folder." },
    ),
  );
}
