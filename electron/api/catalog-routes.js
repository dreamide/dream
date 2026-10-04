// The host catalog over the host's API: read it, change it a set at a
// time, and read or replace a chat's transcript. Changes are announced on
// the host socket's catalog channel (host/catalog.js). The client that made
// a change names itself in the client id header, so its own echo can be
// told apart.
import { z } from "zod";
import { handleJsonRoute } from "./shared/json-route.js";

export const CLIENT_ID_HEADER = "x-dream-client-id";

/** A JSON object (a project, chat or message the codec will repair). */
const plainObject = z.custom(
  (value) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
  "Expected an object.",
);
/** @type {z.ZodArray<z.ZodType<object>>} */
const objects = z.array(/** @type {z.ZodType<object>} */ (plainObject));

export const catalogListRequestSchema = z.object({}).passthrough();

export const catalogChangesRequestSchema = z.object({
  chats: objects.optional(),
  projects: objects.optional(),
  removedChatIds: z.array(z.string().min(1)).optional(),
  removedProjectIds: z.array(z.string().min(1)).optional(),
});

export const catalogTranscriptRequestSchema = z.object({
  chatId: z.string().min(1),
});

export const catalogTranscriptSaveRequestSchema = z.object({
  chatId: z.string().min(1),
  messages: objects,
});

export const catalogSearchRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(200),
});

/**
 * @param {import("hono").Hono} app
 * @param {ReturnType<typeof import("../host/catalog.js").createHostCatalog>} catalog
 */
export function registerCatalogRoutes(app, catalog) {
  const origin = (c) => c.req.header(CLIENT_ID_HEADER) ?? null;

  app.post("/api/catalog", (c) =>
    handleJsonRoute(c, catalogListRequestSchema, () => catalog.list(), {
      missingBody: {},
    }),
  );

  app.post("/api/catalog/changes", (c) =>
    handleJsonRoute(
      c,
      catalogChangesRequestSchema,
      (changes) => catalog.applyChanges(changes, { origin: origin(c) }),
      { errorStatus: 500 },
    ),
  );

  app.post("/api/catalog/transcript", (c) =>
    handleJsonRoute(c, catalogTranscriptRequestSchema, ({ chatId }) =>
      catalog.getTranscript(chatId),
    ),
  );

  app.post("/api/catalog/search", (c) =>
    handleJsonRoute(c, catalogSearchRequestSchema, ({ limit, query }) =>
      catalog.search(query, { limit }),
    ),
  );

  app.put("/api/catalog/transcript", (c) =>
    handleJsonRoute(
      c,
      catalogTranscriptSaveRequestSchema,
      async ({ chatId, messages }) => ({
        saved: await catalog.saveTranscript(chatId, messages, {
          origin: origin(c),
        }),
      }),
      { errorStatus: 500 },
    ),
  );
}
