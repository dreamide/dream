import { describe, expect, test, vi } from "vitest";
import {
  API_ROUTES,
  ApiError,
  type ApiRequestOf,
  type ApiTransportRequest,
  createApiClient,
  createHttpTransport,
  fetchApiBlob,
  getApiErrorMessage,
} from "./api-client";
import { createFakeApiClient, fakeApiError } from "./api-client-fake";

describe("createApiClient", () => {
  test("each method sends its route's method and path with the request", async () => {
    const requests: ApiTransportRequest[] = [];
    const client = createApiClient(async (request) => {
      requests.push(request);
      return { ok: true };
    });
    const controller = new AbortController();

    await client.gitStatus(
      { projectPath: "/p" },
      { signal: controller.signal },
    );
    await client.writeProjectFile({
      content: "a",
      expectedContent: "b",
      filePath: "f",
      projectPath: "/p",
    });

    expect(requests).toEqual([
      {
        body: { projectPath: "/p" },
        method: "POST",
        name: "gitStatus",
        path: "/api/project-git-status",
        signal: controller.signal,
      },
      {
        body: {
          content: "a",
          expectedContent: "b",
          filePath: "f",
          projectPath: "/p",
        },
        method: "PUT",
        name: "writeProjectFile",
        path: "/api/project-file",
        signal: undefined,
      },
    ]);
  });

  test("has one method per route", () => {
    const client = createApiClient(async () => null);
    expect(Object.keys(client).sort()).toEqual(Object.keys(API_ROUTES).sort());
  });
});

describe("createHttpTransport", () => {
  const request = (fetchImpl: typeof fetch) =>
    createApiClient(createHttpTransport(fetchImpl)).gitBranches({
      projectPath: "/p",
    });

  test("posts JSON and resolves with the JSON body", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ branches: [], currentBranch: "main" }),
    );

    await expect(request(fetchImpl)).resolves.toEqual({
      branches: [],
      currentBranch: "main",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/project-git-branches", {
      body: JSON.stringify({ projectPath: "/p" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: undefined,
    });
  });

  test("an error status becomes an ApiError carrying the server's reason", async () => {
    const error = await request(
      async () => new Response("  not a git repository \n", { status: 400 }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "not a git repository",
      path: "/api/project-git-branches",
      reason: "not a git repository",
      status: 400,
    });
  });

  test("an error with no reason still says what failed", async () => {
    await expect(
      request(async () => new Response("", { status: 502 })),
    ).rejects.toThrow("Request failed (502).");
  });
});

describe("getApiErrorMessage", () => {
  test("prefers the server's reason", () => {
    expect(
      getApiErrorMessage(new ApiError("/api/x", 400, "bad path"), "fallback"),
    ).toBe("bad path");
  });

  test("uses the status message, then the fallback, when there is no reason", () => {
    const error = new ApiError("/api/x", 500, "");
    expect(getApiErrorMessage(error, "fallback", (s) => `status ${s}`)).toBe(
      "status 500",
    );
    expect(getApiErrorMessage(error, "fallback")).toBe("fallback");
  });

  test("keeps a network failure's own message", () => {
    expect(getApiErrorMessage(new TypeError("Failed to fetch"), "x")).toBe(
      "Failed to fetch",
    );
    expect(getApiErrorMessage("nope", "fallback")).toBe("fallback");
  });
});

describe("fetchApiBlob", () => {
  test("fails like a JSON route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not a file: x", { status: 400 })),
    );
    try {
      await expect(fetchApiBlob("/api/project-file-raw?x")).rejects.toThrow(
        "Not a file: x",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createFakeApiClient", () => {
  test("answers from handlers and records calls by name", async () => {
    const { calls, client } = createFakeApiClient({
      gitLog: ({ skip }) => ({ commits: [], hasMore: (skip ?? 0) < 100 }),
    });

    await expect(
      client.gitLog({ projectPath: "/p", skip: 0 }),
    ).resolves.toEqual({ commits: [], hasMore: true });
    expect(calls).toEqual([
      { name: "gitLog", request: { projectPath: "/p", skip: 0 } },
    ]);
  });

  test("a route with no handler fails like a missing route", async () => {
    const { client } = createFakeApiClient();
    await expect(client.gitStatus({ projectPath: "/p" })).rejects.toMatchObject(
      { status: 404 },
    );
  });

  test("handlers can fail with a server-style error", async () => {
    const { client } = createFakeApiClient({
      gitCheckout: () => {
        throw fakeApiError("gitCheckout", 409, "branch exists");
      },
    });
    await expect(
      client.gitCheckout({ branchName: "x", projectPath: "/p" }),
    ).rejects.toThrow("branch exists");
  });
});

// Request types come from the server's schemas; these lines only compile if
// the schema says so (checked by `tsc`).
type Diff = ApiRequestOf<"gitDiff">;
type Upgrade = ApiRequestOf<"cliUpgrade">;
type Status = ApiRequestOf<"gitStatus">;
type Checkout = ApiRequestOf<"gitCheckout">;

test("request types follow the server schemas (checked by tsc)", () => {
  // @ts-expect-error projectPath is required by the schema.
  const missingProjectPath: Status = {};
  // @ts-expect-error status must be one of the schema's change statuses.
  const unknownStatus: Diff["status"] = "moved";
  // @ts-expect-error provider must be a CLI Dream can upgrade.
  const unknownCli: Upgrade["provider"] = "unknown";
  // Fields with a schema default are optional.
  const defaultsOptional: Checkout = { branchName: "main", projectPath: "/p" };

  expect([
    missingProjectPath,
    unknownStatus,
    unknownCli,
    defaultsOptional,
  ]).toHaveLength(4);
});
