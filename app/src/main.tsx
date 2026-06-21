import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import AppX from "./app_x/index.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppX />
  </StrictMode>,
);
