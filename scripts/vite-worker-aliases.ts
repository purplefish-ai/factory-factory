import { createRequire } from 'node:module';

const requireFromRefractor = createRequire(import.meta.resolve('refractor'));
const requireFromEntities = createRequire(requireFromRefractor.resolve('parse-entities'));

// Refractor's entity decoder offers a DOM-free default export, but its browser
// export calls document.createElement at module load. Vite shares dependency
// resolution with module workers in dev, so use the DOM-free version in both
// environments. Resolve through the owning dependencies to support pnpm layouts.
export const workerSafeAliases = {
  'decode-named-character-reference': requireFromEntities.resolve(
    'decode-named-character-reference'
  ),
};
