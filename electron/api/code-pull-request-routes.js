// The PR panel's one route: each action is the GitHub pull requests module's
// (project-git/pull-requests.js).

import { HOST_ROUTES } from "../shared/host-routes.js";
import { codePullRequestRequestSchema } from "./code-pull-request-schemas.js";
import { gitHubPullRequests } from "./project-git/pull-requests.js";
import { handleJsonRoute } from "./shared/json-route.js";
import { registerRoute } from "./shared/register-route.js";

export function registerCodePullRequestRoutes(app) {
  registerRoute(app, HOST_ROUTES.codePullRequests, (c) =>
    handleJsonRoute(
      c,
      codePullRequestRequestSchema,
      gitHubPullRequests.execute,
      {
        errorMessage: "Unable to access GitHub.",
        invalidMessage: "Invalid pull request request.",
        missingBody: null,
      },
    ),
  );
}
