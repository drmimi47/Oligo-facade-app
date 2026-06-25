import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import PolylineTool from "./PolylineTool";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PolylineTool />
  </StrictMode>,
);
