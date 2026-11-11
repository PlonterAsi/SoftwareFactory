import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary, installErrorCatcher } from "./BugReport";
import "./styles.css";

installErrorCatcher();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary where="the Bridge">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
