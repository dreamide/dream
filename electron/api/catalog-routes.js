// The host catalog over the host's API: read it, change it a set at a
// time, and read or replace a chat's transcript. Changes are announced on
// the host socket's catalog channel (host/catalog.js). The client that made
// a change names itself in the client id header, so its own echo can be
// told apart.
import { z } from "zod";
import { HOST_ROUTES } from "../shared/host-routes.js";
import { handleJsonRoute } from "./shared/json-route.js";
import { registerRoute } from "./shared/register-route.js";

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
export const catalogTranscriptPageSchema =
  catalogTranscriptRequestSchema.extend({
    before: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  });

export const catalogTranscriptSaveRequestSchema = z.object({
  chatId: z.string().min(1),
  messages: objects,
  mergeOnly: z.boolean().optional(),
});

export const catalogSearchRequestSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
  query: z.string().trim().min(1).max(200),
});

/**
 * @param {import("hono").Hono} app
 * @param {ReturnType<typeof import("../host/catalog.js").createHostCatalog>} catalog
 * @param {{ describeHost?: () => object }} [options]
 *   `describeHost`: the host's descriptor (identity and protocol), listed
 *   with the catalog as `host` so a client checks whose catalog it is in
 *   the same response it applies.
 */
export function registerCatalogRoutes(app, catalog, { describeHost } = {}) {
  registerRoute(app, HOST_ROUTES.catalogTranscriptPage, (c) =>
    handleJsonRoute(c, catalogTranscriptPageSchema, (data) =>
      catalog.transcriptPage(data),
    ),
  );
  const origin = (c) => c.req.header(CLIENT_ID_HEADER) ?? null;

  registerRoute(app, HOST_ROUTES.catalog, (c) =>
    handleJsonRoute(
      c,
      catalogListRequestSchema,
      async () => ({
        ...(await catalog.list()),
        ...(describeHost ? { host: describeHost() } : {}),
      }),
      { missingBody: {} },
    ),
  );

  registerRoute(app, HOST_ROUTES.catalogChanges, (c) =>
    handleJsonRoute(
      c,
      catalogChangesRequestSchema,
      (changes) => catalog.applyChanges(changes, { origin: origin(c) }),
      { errorStatus: 500 },
    ),
  );

  // The transcript's JSON as stored, sent without parsing it here.
  registerRoute(app, HOST_ROUTES.catalogTranscript, (c) =>
    handleJsonRoute(c, catalogTranscriptRequestSchema, async ({ chatId }) =>
      c.body(await catalog.getTranscriptJson(chatId), 200, {
        "Content-Type": "application/json",
      }),
    ),
  );

  registerRoute(app, HOST_ROUTES.catalogSearch, (c) =>
    handleJsonRoute(c, catalogSearchRequestSchema, ({ limit, query }) =>
      catalog.search(query, { limit }),
    ),
  );

  registerRoute(app, HOST_ROUTES.saveCatalogTranscript, (c) =>
    handleJsonRoute(
      c,
      catalogTranscriptSaveRequestSchema,
      async ({ chatId, messages, mergeOnly }) => ({
        saved: await catalog.saveTranscript(chatId, messages, {
          mergeOnly,
          origin: origin(c),
        }),
      }),
      { errorStatus: 500 },
    ),
  );
}
