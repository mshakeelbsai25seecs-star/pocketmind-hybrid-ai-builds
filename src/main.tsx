import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { applyThemeClass, readStoredTheme } from "./themeBootstrap";
import AppErrorBoundary from "./components/AppErrorBoundary";

// Apply persisted/system theme before the first React paint.
applyThemeClass(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);
