// @vitest-environment jsdom
import { CameraIcon } from '@phosphor-icons/react/dist/csr/Camera';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { EmptyState } from './empty-state';

function render(element: React.ReactElement) {
  return new DOMParser().parseFromString(renderToStaticMarkup(element), 'text/html').body;
}

it('renders the title, description, decorative icon and action', () => {
  const body = render(
    <EmptyState
      icon={CameraIcon}
      title="No screenshots yet"
      description="Capture screenshots of the running dev app."
      action={<button type="button">Take screenshots</button>}
    />
  );
  expect(body.textContent).toContain('No screenshots yet');
  expect(body.textContent).toContain('Capture screenshots of the running dev app.');
  expect(body.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  expect(body.querySelector('button')?.textContent).toBe('Take screenshots');
});

it('omits the icon, description and action slots when they are not given', () => {
  const body = render(<EmptyState title="No diff available" />);
  expect(body.querySelector('svg')).toBeNull();
  expect(body.querySelectorAll('p')).toHaveLength(1);
  expect(body.querySelector('button')).toBeNull();
});

it('uses a smaller icon and padding in the compact size', () => {
  const regular = render(<EmptyState icon={CameraIcon} title="Empty" />);
  const compact = render(<EmptyState icon={CameraIcon} size="compact" title="Empty" />);
  expect(regular.querySelector('svg')?.getAttribute('class')).toContain('size-8');
  expect(compact.querySelector('svg')?.getAttribute('class')).toContain('size-6');
  expect(compact.querySelector('[data-slot="empty-state"]')?.className).toContain('p-4');
});

it('lets a cautionary empty state recolor its icon', () => {
  const body = render(<EmptyState icon={CameraIcon} iconClassName="text-warning" title="Empty" />);
  expect(body.querySelector('svg')?.getAttribute('class')).toContain('text-warning');
});
