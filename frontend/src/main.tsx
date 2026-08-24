import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import ErrorBoundary from "./ui/ErrorBoundary";

// URL-based routing: /world renders the open-world driving game, anything
// else renders the original parking guidance simulator. The open-world
// feature is under construction and its files are not yet in the repo,
// so we only render the garage for now. When the world feature is ready,
// wrap WorldApp in lazy(() => import("./world/WorldApp")) + Suspense.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
