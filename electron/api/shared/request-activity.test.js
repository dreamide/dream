import { Hono } from "hono";
import { expect, test } from "vitest";
import { trackRequestActivity } from "./request-activity.js";

const setup = () => {
  let inFlight = 0;
  const app = new Hono();
  trackRequestActivity(
    app,
    {
      begin: () => {
        inFlight += 1;
      },
      end: () => {
        inFlight -= 1;
      },
    },
    { skipPaths: ["/api/skipped"] },
  );
  return { app, inFlight: () => inFlight };
};

test("a JSON answer counts until its body is read", async () => {
  const { app, inFlight } = setup();
  app.get("/api/json", (c) => c.json({ ok: true }));

  const response = await app.request("/api/json");
  expect(await response.json()).toEqual({ ok: true });
  expect(inFlight()).toBe(0);
});

test("a streamed answer counts until the stream ends", async () => {
  const { app, inFlight } = setup();
  let finish;
  app.get(
    "/api/stream",
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("a"));
            finish = () => controller.close();
          },
        }),
      ),
  );

  const response = await app.request("/api/stream");
  const reader = response.body.getReader();
  await reader.read();
  expect(inFlight()).toBe(1);

  finish();
  await reader.read();
  expect(inFlight()).toBe(0);
});

test("a cancelled stream stops counting", async () => {
  const { app, inFlight } = setup();
  app.get(
    "/api/stream",
    () => new Response(new ReadableStream({ start() {} })),
  );

  const response = await app.request("/api/stream");
  expect(inFlight()).toBe(1);
  await response.body.cancel();
  expect(inFlight()).toBe(0);
});

test("skipped paths and failures are not left counted", async () => {
  const { app, inFlight } = setup();
  app.get("/api/skipped", (c) => c.text("x"));
  app.get("/api/throws", () => {
    throw new Error("boom");
  });

  await app.request("/api/skipped");
  // Hono answers the error with a 500; it counts until that body is read.
  const failed = await app.request("/api/throws");
  expect(failed.status).toBe(500);
  await failed.text();
  expect(inFlight()).toBe(0);
});
