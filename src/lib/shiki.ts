/**
 * Workers-safe Shiki highlighter for EmDash Portable Text code blocks.
 *
 * Uses the JavaScript RegExp engine (not WASM/Oniguruma) so it works inside
 * Cloudflare Workers without any Wasm bundling dance.
 *
 * Catppuccin Latte (light) and Catppuccin Mocha (dark) are loaded with
 * `defaultColor: false` so Shiki emits CSS variables (`--shiki-light`,
 * `--shiki-dark`, etc.) that the existing `.code-block` styles already consume.
 *
 * The highlighter promise is cached at module scope so it is created once and
 * reused across all requests in the same Worker isolate.
 */

import { createBundledHighlighter, createJavaScriptRegexEngine, createSingletonShorthands, bundledLanguages, bundledThemes } from "shiki";

/**
 * Factory + shorthands using the JavaScript RegExp engine instead of the
 * default Oniguruma (WASM) engine. The `codeToHtml` shorthand auto-loads
 * languages on demand so we never pay for grammars we do not use.
 */
const { codeToHtml } = createSingletonShorthands(
  createBundledHighlighter({
    langs: bundledLanguages,
    themes: bundledThemes,
    engine: () => createJavaScriptRegexEngine(),
  }),
);

/**
 * Highlight source code with Shiki, emitting dual-theme HTML.
 *
 * Languages are auto-loaded on first use via the bundled language registry.
 * Unknown or missing languages safely fall back to plain text.
 *
 * @param code      - The source code string.
 * @param language  - Optional language identifier (e.g. "typescript", "css").
 *                    When absent or unrecognised the output is plain text.
 * @returns         HTML string produced by `codeToHtml`.
 */
export async function highlightCode(
  code: string,
  language?: string,
): Promise<string> {
  const lang = language && language.trim() ? language.trim() : "text";

  try {
    return await codeToHtml(code, {
      lang,
      themes: {
        light: "catppuccin-latte",
        dark: "catppuccin-mocha",
      },
      defaultColor: false,
    });
  } catch {
    // If the language is unknown or Shiki throws for any reason, fall back to
    // plain text so the code is still readable.
    return await codeToHtml(code, {
      lang: "text",
      themes: {
        light: "catppuccin-latte",
        dark: "catppuccin-mocha",
      },
      defaultColor: false,
    });
  }
}
