import type { TazhanApi } from "../preload/index";

declare global {
  interface Window {
    tazhan: TazhanApi;
  }
}

export {};

