import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App.tsx";
import "./styles.css";

// After a new deploy, a tab opened earlier asks for old file names that no
// longer exist. Reload once to pick up the new version.
window.addEventListener("vite:preloadError", (e) => {
  try {
    if (sessionStorage.getItem("autovideo.reloaded")) return;
    sessionStorage.setItem("autovideo.reloaded", "1");
  } catch {
    // storage blocked: reload anyway
  }
  e.preventDefault();
  location.reload();
});
window.addEventListener("load", () => setTimeout(() => {
  try {
    sessionStorage.removeItem("autovideo.reloaded");
  } catch {
    // ignore
  }
}, 10_000));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);

// App-shell cache only; the production pipeline never runs in the browser.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
}
