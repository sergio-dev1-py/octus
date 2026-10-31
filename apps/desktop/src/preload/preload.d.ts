import type { OctusPreloadApi } from "../preload/index.js";

declare global {
  interface Window {
    octus: OctusPreloadApi;
  }
}

export {};
