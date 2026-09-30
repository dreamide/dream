import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { test } from "vitest";
import { z } from "zod";
import { handleJsonRoute, postProjectRoute, RouteError } from "./json-route.js";

const schema = z.object({ count: z.number().int().default(1) });

const createApp = (handler, options) => {
  const app = new Hono();
  app.post("/route", (c) => handleJsonRoute(c, schema, handler, options));
  return app;
};

const post = (app, body, url = "/route") =>
  app.request(url, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

test("answers with the handler's JSON, given the parsed body", async () => {
  const app = createApp(({ count }) => ({ doubled: count * 2 }));
  const response = await post(app, {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { doubled: 2 });
});

test("refuses a body that is not JSON, unless it has a stand-in", async () => {
  const refused = await post(
    createApp(() => ({})),
    "{",
  );
  assert.equal(refused.status, 400);
  assert.equal(await refused.text(), "Invalid JSON payload.");

  const standIn = await post(
    createApp(({ count }) => ({ count }), { missingBody: { count: 5 } }),
    "{",
  );
  assert.deepEqual(await standIn.json(), { count: 5 });
});

test("a schema failure answers 400 with the zod message or the route's own", async () => {
  const zodMessage = await post(
    createApp(() => ({})),
    { count: "x" },
  );
  assert.equal(zodMessage.status, 400);
  assert.match(await zodMessage.text(), /count/);

  const ownMessage = await post(
    createApp(() => ({}), { invalidMessage: "Invalid thing." }),
    { count: "x" },
  );
  assert.equal(await ownMessage.text(), "Invalid thing.");
});

test("a thrown error answers as text with the route's status", async () => {
  const withMessage = await post(
    createApp(() => {
      throw new Error("git failed");
    }),
    {},
  );
  assert.equal(withMessage.status, 400);
  assert.equal(await withMessage.text(), "git failed");

  const withoutMessage = await post(
    createApp(
      () => {
        throw new Error("");
      },
      { errorMessage: "Unable to do it.", errorStatus: 500 },
    ),
    {},
  );
  assert.equal(withoutMessage.status, 500);
  assert.equal(await withoutMessage.text(), "Unable to do it.");
});

test("an error carrying a status answers with it", async () => {
  const routeError = await post(
    createApp(() => {
      throw new RouteError("Too large.", 413);
    }),
    {},
  );
  assert.equal(routeError.status, 413);

  const notFound = Object.assign(new Error("Checkpoint not found."), {
    httpStatus: 404,
  });
  const tagged = await post(
    createApp(() => {
      throw notFound;
    }),
    {},
  );
  assert.equal(tagged.status, 404);
  assert.equal(await tagged.text(), "Checkpoint not found.");
});

test("a Response from the handler is sent as is", async () => {
  const response = await post(
    createApp(() => new Response("raw", { status: 202 })),
    {},
  );
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "raw");
});

test("project routes check the project directory first", async () => {
  const app = new Hono();
  postProjectRoute(
    app,
    "/project",
    z.object({ projectPath: z.string() }),
    () => ({ ok: true }),
  );
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dream-route-"));

  try {
    const ok = await post(app, { projectPath: directory }, "/project");
    assert.deepEqual(await ok.json(), { ok: true });

    const missing = await post(
      app,
      { projectPath: path.join(directory, "missing") },
      "/project",
    );
    assert.equal(missing.status, 400);
  } finally {
    await fs.rm(directory, { force: true, recursive: true });
  }
});
