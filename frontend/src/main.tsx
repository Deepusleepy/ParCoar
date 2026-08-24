import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import ErrorBoundary from "./ui/ErrorBoundary";

// URL-based routing: /world renders the open-world driving game, anything
// else renders the original parking guidance simulator. No react-router
// dependency — just a popstate listener so the back button works.
// WorldApp is lazy-loaded so the garage route doesn't pay the transform
// cost (or fail) when the open-world feature has missing files.
const WorldApp = lazy(() =>
  import("./world/WorldApp").then((m) => ({ default: m.WorldApp })),
);

function getRoute(): "world" | "garage" {
  return window.location.pathname === "/world" ? "world" : "garage";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {getRoute() === "world" ? (
        <Suspense fallback={null}>
          <WorldApp />
        </Suspense>
      ) : (
        <App />
      )}
    </ErrorBoundary>
  </StrictMode>,
);
