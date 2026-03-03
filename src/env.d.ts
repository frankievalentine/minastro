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

  interface PagefindResult {
    url: string;
    meta: Record<string, string>;
    excerpt: string;
    anchors: Array<{
      element: string;
      id: string;
      text: string;
      location: number;
    }>;
    content: string;
    word_count: number;
  }

  interface PagefindSearchResult {
    id: string;
    data: () => Promise<PagefindResult>;
  }

  interface PagefindModule {
    init: () => Promise<void>;
    debouncedSearch: (
      query: string,
      options: Record<string, unknown>,
      timeout: number,
    ) => Promise<{ results: PagefindSearchResult[] } | null>;
  }
}
