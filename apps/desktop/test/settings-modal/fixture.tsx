/** Fixture del test settings-modal (todo 4): monta el SettingsView REAL con el
 * CSS real. Se compila con el vite + vite-plugin-solid del repo (la misma
 * cadena que produccion) y se maneja en Chromium real via playwright-core.
 * `?tall=1` siembra 30 proveedores para el caso de overflow con scroll interno.
 */
import { render } from "solid-js/web";
import { SettingsView } from "../../src/renderer/src/views/settings.jsx";
import "../../src/renderer/src/styles.css";
import { setState } from "../../src/renderer/src/store.js";
import type { ProviderDescriptor } from "@octus/shared";

const tall = new URLSearchParams(location.search).has("tall");
const count = tall ? 30 : 3;

const providers: ProviderDescriptor[] = Array.from({ length: count }, (_, i) => ({
  id: `p${i + 1}`,
  displayName: `Proveedor ${i + 1}`,
  configured: false,
  models: [
    {
      providerId: `p${i + 1}`,
      modelId: `m${i + 1}`,
      displayName: `Modelo ${i + 1}`,
      capabilities: {
        toolCall: true,
        reasoningEfforts: ["low", "high"],
        maxContextTokens: 128000,
        maxOutputTokens: 16000,
        supportsImages: false,
      },
    },
  ],
}));
setState("providers", providers);

declare global {
  interface Window {
    __settingsClosed?: boolean;
  }
}

const root = document.getElementById("root")!;
const dispose = render(
  () => (
    <SettingsView
      onClose={() => {
        window.__settingsClosed = true;
        dispose();
      }}
    />
  ),
  root
);
