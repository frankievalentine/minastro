import eslint from "@eslint/js";
import eslintPluginAstro from "eslint-plugin-astro";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config([
  eslint.configs.recommended,
  tseslint.configs.recommended,
  ...eslintPluginAstro.configs["flat/recommended"],
  jsxA11y.flatConfigs.recommended,
  {
    // jsx-a11y expects `htmlFor` (JSX prop) but Astro uses the HTML `for` attribute.
    // The eslint-plugin-astro handles Astro-native a11y; suppress the false positive here.
    files: ["**/*.astro"],
    rules: {
      "jsx-a11y/label-has-associated-control": "off",
    },
  },
  {
    ignores: ["dist/**", ".astro/**", "node_modules/**"],
  },
]);
