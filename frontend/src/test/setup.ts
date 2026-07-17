import { afterAll, afterEach, beforeAll, expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { server } from './mocks';

// NOTE: importing '@testing-library/jest-dom/vitest' directly does not work in
// this monorepo because the frontend workspace resolves a nested vitest@4.x
// (needed for vite@8 compatibility) while root-hoisted vitest stays on ^2.0.0
// for backend/shared. That side-effecting import resolves 'vitest' relative
// to its own (root-hoisted) location and would extend a *different* `expect`
// instance than the one frontend's test files import. Extending explicitly
// here, in this module (which resolves 'vitest' the same way test files do),
// avoids that split-instance problem.
expect.extend(matchers);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); cleanup(); window.history.pushState({}, '', '/'); });
afterAll(() => server.close());
