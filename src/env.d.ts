/// <reference types="astro/client" />

export {};

declare global {
  interface Window {
    basecoat?: {
      stop: () => void;
      initAll: () => void;
      start: () => void;
      init: (component: string) => void;
    };
  }
}
