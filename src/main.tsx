import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyThemeClass, readStoredTheme } from "./themeBootstrap";

// Apply persisted/system theme before the first React paint.
const bootTheme = readStoredTheme();
const bootDark = applyThemeClass(bootTheme);

// #region agent log
(() => {
  try {
    const html = document.documentElement;
    const body = document.body;
    const cs = body ? getComputedStyle(body) : null;
    fetch("http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "7d5a77",
      },
      body: JSON.stringify({
        sessionId: "7d5a77",
        runId: "white-ui-2",
        hypothesisId: "H1",
        location: "main.tsx:boot",
        message: "first_js_paint_theme_state",
        data: {
          bootTheme,
          bootDark,
          htmlClass: html.className,
          hasDarkClass: html.classList.contains("dark"),
          bodyBg: cs ? cs.backgroundColor : null,
          prefersDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
          rootChildCount: document.getElementById("root")?.childElementCount ?? -1,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => undefined);
  } catch {
    // ignore debug probe failures
  }
})();
// #endregion

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
