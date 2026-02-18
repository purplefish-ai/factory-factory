import { useEffect, useState } from 'react';

const DEFAULT_VIEWPORT_HEIGHT = '100dvh';
const DEFAULT_VIEWPORT_OFFSET = '0px';

function toPixels(value: number): string {
  return `${Math.round(value)}px`;
}

interface VisualViewportLayout {
  height: string;
  offsetTop: string;
}

const DEFAULT_LAYOUT: VisualViewportLayout = {
  height: DEFAULT_VIEWPORT_HEIGHT,
  offsetTop: DEFAULT_VIEWPORT_OFFSET,
};

export function useVisualViewportHeight(): VisualViewportLayout {
  const [layout, setLayout] = useState<VisualViewportLayout>(DEFAULT_LAYOUT);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const visualViewport = window.visualViewport;

    const updateLayout = (nextLayout: VisualViewportLayout) => {
      setLayout((previousLayout) =>
        previousLayout.height === nextLayout.height &&
        previousLayout.offsetTop === nextLayout.offsetTop
          ? previousLayout
          : nextLayout
      );
    };

    const updateFromWindow = () => {
      updateLayout({
        height: toPixels(window.innerHeight),
        offsetTop: DEFAULT_VIEWPORT_OFFSET,
      });
    };

    if (!visualViewport) {
      updateFromWindow();
      window.addEventListener('resize', updateFromWindow);
      return () => {
        window.removeEventListener('resize', updateFromWindow);
      };
    }

    const updateFromVisualViewport = () => {
      updateLayout({
        height: toPixels(visualViewport.height),
        offsetTop: toPixels(visualViewport.offsetTop),
      });
    };

    updateFromVisualViewport();
    visualViewport.addEventListener('resize', updateFromVisualViewport);
    visualViewport.addEventListener('scroll', updateFromVisualViewport);

    return () => {
      visualViewport.removeEventListener('resize', updateFromVisualViewport);
      visualViewport.removeEventListener('scroll', updateFromVisualViewport);
    };
  }, []);

  return layout;
}
