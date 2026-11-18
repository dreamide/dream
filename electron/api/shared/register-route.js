// Registers a host route by its row in the route table
// (electron/shared/host-routes.js), so the row's method and path are the
// ones served: `registerRoute(app, HOST_ROUTES.catalog, handler)`.

/**
 * @param {import("hono").Hono} app
 * @param {{ method: string, path: string }} route a row of HOST_ROUTES (or
 *   the desktop edge's own forwarding)
 * @param {...Function} handlers what `app.on` takes after the path
 */
export const registerRoute = (app, route, ...handlers) =>
  app.on(route.method, route.path, ...handlers);
