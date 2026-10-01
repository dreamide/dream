// Counts the API requests still in flight, including a streamed response
// until its body has finished (an agent turn streams for minutes). A daemon
// uses it to tell an idle host from one that is still working.

/**
 * @param {import("hono").Hono} app
 * @param {{ begin: () => void, end: () => void }} activity
 * @param {{ skipPaths?: string[] }} [options]
 *   `skipPaths`: requests not counted (the host socket, whose clients
 *   the host counts itself).
 */
export function trackRequestActivity(app, activity, { skipPaths = [] } = {}) {
  app.use("/api/*", async (c, next) => {
    if (skipPaths.includes(c.req.path)) {
      await next();
      return;
    }

    activity.begin();
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      activity.end();
    };

    try {
      await next();
    } catch (error) {
      end();
      throw error;
    }

    const body = c.res.body;
    if (!body) {
      end();
      return;
    }

    const tracked = body.pipeThrough(
      new TransformStream({
        cancel: end,
        flush: end,
      }),
    );
    c.res = new Response(tracked, c.res);
  });
}
