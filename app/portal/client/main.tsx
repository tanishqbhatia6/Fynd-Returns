import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReturnPortalApp } from "./App";
import { readBootstrap } from "./utils";

const root = document.getElementById("return-portal-root");

if (root) {
  createRoot(root).render(
    <StrictMode>
      <ReturnPortalApp bootstrap={readBootstrap()} />
    </StrictMode>,
  );
}
