import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyAccentColor, applyThemeClass, readStoredAccent, readStoredTheme } from "./themeBootstrap";
import AppErrorBoundary from "./components/AppErrorBoundary";

// Apply persisted theme + accent before the first React paint.
applyThemeClass(readStoredTheme());
applyAccentColor(readStoredAccent());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
