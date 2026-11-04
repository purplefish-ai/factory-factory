import { configure } from 'storybook/test';

// Setup for `pnpm test:storybook` only; Storybook itself never loads this file.

// Story tests assert on settled UI. Enter and exit animations (dialogs, selects,
// toasts) otherwise leave elements transparent or `pointer-events: none` for a
// few frames, which makes play functions race the animation. Radix and Sonner
// treat `animation: none` as "no animation" and mount or unmount immediately.
const style = document.createElement('style');
style.dataset.storyTests = 'disable-motion';
style.textContent = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
`;
document.head.append(style);

// The whole suite shares one Vite server, so the first story to need a lazy
// chunk or worker (syntax highlighting, for example) can wait on a cold
// transform. Give `findBy*` and `waitFor` more headroom than the 1s default.
configure({ asyncUtilTimeout: 5000 });
