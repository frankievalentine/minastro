# ESLint Code Standards

This project uses **ESLint** with TypeScript, Astro, and jsx-a11y plugins for code quality and accessibility checking.

## Quick Reference

- **Check types + lint**: `bun run check`
- **Auto-fix lint issues**: `bun run fix`

ESLint provides linting; `astro check` handles TypeScript type checking for `.astro` files. Most common issues are automatically fixable with `bun run fix`.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### Accessibility (jsx-a11y)

- Use semantic HTML elements (`<button>`, `<nav>`, `<dialog>`, etc.) instead of divs with roles
- Provide meaningful alt text for images
- Use proper heading hierarchy
- Add labels for form inputs
- Include keyboard event handlers alongside mouse events
- Add `rel="noopener noreferrer"` when using `target="_blank"` on links
- Avoid attaching event handlers to non-interactive elements; use document-level delegation instead

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators — avoid ternaries as statements
- Group related code together and separate concerns

### Security

- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When ESLint Can't Help

ESLint catches common issues automatically. Focus your attention on:

1. **Business logic correctness** - ESLint can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations

---

Run `bun run fix` before committing to auto-fix common issues, then `bun run check` to catch any remaining type errors or lint violations.
