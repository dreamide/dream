import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { AppErrorBoundary } from "./components/app-error-boundary";
import "./app/globals.css";
import { HOST_ROUTES } from "../electron/shared/host-routes.js";
import { hostFetch } from "./lib/connections/host-endpoint";
import { startConnectionRuntime } from "./lib/connections/runtime";
import { LOCAL_HOST_ID } from "./lib/host-routing";

// A browser client asks its home host whether its session still holds
// (at start and whenever it comes back); the desktop's is its own process.
startConnectionRuntime({
  probeHome: () => hostFetch(LOCAL_HOST_ID, HOST_ROUTES.remoteSession.path),
});

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
