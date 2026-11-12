import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary, installErrorCatcher } from "./BugReport";
// Fonts ship inside the app (latin subset only), so the installed app looks the same offline.
import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-sans/latin-700.css";
import "@fontsource/geist-mono/latin-400.css";
import "@fontsource/geist-mono/latin-500.css";
import "./styles.css";

installErrorCatcher();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary where="the Bridge">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
