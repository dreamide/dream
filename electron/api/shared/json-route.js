// The shape every JSON route shares: read the body, validate it against the
// route's zod schema, run the handler, answer with JSON or a plain-text
// error. The renderer's route client (src/lib/api-client.ts) is the other
// side of this contract: it takes its request types from the same schemas
// and reads the plain-text error back as the message.
import { ensureProjectDirectory } from "../project-git/files.js";

/**
 * An error a handler throws to answer with a specific status. Any other
 * error answers with the route's `errorStatus`.
 */
export class RouteError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   */
  constructor(message, status) {
    super(message);
    this.name = "RouteError";
    this.httpStatus = status;
  }
}

const NOT_JSON = Symbol("not-json");

const readJsonBody = async (c) => {
  try {
    return await c.req.json();
  } catch {
    return NOT_JSON;
  }
};

/**
 * @param {import("hono").Context} c
 * @param {import("zod").ZodType} schema
 * @param {(data: any, c: import("hono").Context) => unknown} handler
 *   Returns the JSON body, or a `Response` to send as is.
 * @param {{
 *   errorMessage?: string,
 *   errorStatus?: number,
 *   invalidMessage?: string,
 *   missingBody?: unknown,
 *   requireProjectDirectory?: boolean,
 * }} [options]
 *   `errorMessage`: sent when a thrown error has no message.
 *   `errorStatus`: the status for thrown errors (default 400).
 *   `invalidMessage`: sent when the body fails the schema; the zod message
 *   when omitted.
 *   `missingBody`: validated in place of a body that is not JSON; when
 *   omitted such a body is refused.
 *   `requireProjectDirectory`: checks `projectPath` is a directory first.
 */
export const handleJsonRoute = async (c, schema, handler, options = {}) => {
  const {
    errorMessage = "Request failed.",
    errorStatus = 400,
    invalidMessage,
    requireProjectDirectory = false,
  } = options;

  let body = await readJsonBody(c);
  if (body === NOT_JSON) {
    if (!("missingBody" in options)) {
      return c.text("Invalid JSON payload.", 400);
    }
    body = options.missingBody;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return c.text(invalidMessage ?? parsed.error.message, 400);
  }

  try {
    if (requireProjectDirectory) {
      await ensureProjectDirectory(parsed.data.projectPath);
    }
    const result = await handler(parsed.data, c);
    return result instanceof Response ? result : c.json(result);
  } catch (error) {
    const status =
      error && typeof error === "object" && "httpStatus" in error
        ? Number(error.httpStatus)
        : errorStatus;
    const message =
      error instanceof Error && error.message ? error.message : errorMessage;
    return c.text(message, status);
  }
};

/**
 * Registers a POST JSON route whose `projectPath` must be a directory, the
 * common case for the project routes.
 */
export const postProjectRoute = (app, path, schema, handler, options = {}) =>
  app.post(path, (c) =>
    handleJsonRoute(c, schema, handler, {
      requireProjectDirectory: true,
      ...options,
    }),
  );
