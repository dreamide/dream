/**
 * The in-memory adapter behind the route client, for tests: each route a
 * test cares about gets a handler returning a typed response, and every call
 * is recorded by method name. A route with no handler fails like a server
 * that does not have it.
 */
import {
  API_ROUTES,
  type ApiClient,
  ApiError,
  type ApiRequestOf,
  type ApiResponseOf,
  type ApiRouteName,
  createApiClient,
} from "./api-client";

export type FakeApiHandlers = {
  [Name in ApiRouteName]?: (
    request: ApiRequestOf<Name>,
  ) => ApiResponseOf<Name> | Promise<ApiResponseOf<Name>>;
};

export interface FakeApiCall {
  name: ApiRouteName;
  request: unknown;
}

/** Fails a fake call the way the server would: status plus plain-text reason. */
export const fakeApiError = (
  name: ApiRouteName,
  status: number,
  reason: string,
) => new ApiError(API_ROUTES[name].path, status, reason);

export const createFakeApiClient = (
  handlers: FakeApiHandlers = {},
): { calls: FakeApiCall[]; client: ApiClient } => {
  const calls: FakeApiCall[] = [];
  const client = createApiClient(async ({ body, name }) => {
    calls.push({ name, request: body });
    const handler = handlers[name] as
      | ((request: unknown) => unknown)
      | undefined;
    if (!handler) {
      throw fakeApiError(name, 404, `No fake handler for ${name}.`);
    }
    // Clone like a round trip would, so a test cannot share state by accident.
    return structuredClone(await handler(structuredClone(body)));
  });
  return { calls, client };
};
