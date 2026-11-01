/** Entrada QA del catalogo Todo 7 (solo verificacion, no producto).
    Se compila con vite + vite-plugin-solid en scripts/qa-task-7.mjs y se abre
    en Chromium real. No se importa desde App ni desde el catalogo. */
import { render } from "solid-js/web";
import CatalogView from "../apps/desktop/src/renderer/src/components/catalog.jsx";
import "../apps/desktop/src/renderer/src/design/tokens.css";
import "../apps/desktop/src/renderer/src/components/oc-components.css";

const root = document.getElementById("oc-qa-root");
if (!root) throw new Error("missing #oc-qa-root");
render(() => <CatalogView />, root);
