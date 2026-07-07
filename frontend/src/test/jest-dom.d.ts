// Type-only augmentation of vitest's `Assertion` with jest-dom matchers.
//
// We can't use the usual `/// <reference types="@testing-library/jest-dom/vitest" />`
// (or importing '@testing-library/jest-dom/vitest' for its side effects) here: that
// declaration file lives under the root-hoisted node_modules and does `declare module
// 'vitest'` relative to *its own* location, which resolves to the root-hoisted
// vitest@2 used by the backend/shared workspaces. This workspace resolves its own
// nested vitest@4 (required for vite@8 compatibility), a structurally different
// module as far as TypeScript is concerned. Declaring the augmentation in a file that
// lives inside this workspace makes `declare module 'vitest'` resolve against the same
// vitest instance our test files import.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<T = any> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
}
