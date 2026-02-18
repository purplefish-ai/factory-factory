import { useEffect, useState } from 'react';

const DEFAULT_VIEWPORT_HEIGHT = '100dvh';

function toPixels(value: number): string {
  return `${Math.round(value)}px`;
}

export function useVisualViewportHeight(): string {
  const [viewportHeight, setViewportHeight] = useState<string>(DEFAULT_VIEWPORT_HEIGHT);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const visualViewport = window.visualViewport;

    const updateHeight = (nextHeight: string) => {
      setViewportHeight((previousHeight) =>
        previousHeight === nextHeight ? previousHeight : nextHeight
      );
    };

    const updateFromWindow = () => {
      updateHeight(toPixels(window.innerHeight));
    };

    if (!visualViewport) {
      updateFromWindow();
      window.addEventListener('resize', updateFromWindow);
      return () => {
        window.removeEventListener('resize', updateFromWindow);
      };
    }

    const updateFromVisualViewport = () => {
      updateHeight(toPixels(visualViewport.height));
    };

    updateFromVisualViewport();
    visualViewport.addEventListener('resize', updateFromVisualViewport);
    visualViewport.addEventListener('scroll', updateFromVisualViewport);

    return () => {
      visualViewport.removeEventListener('resize', updateFromVisualViewport);
      visualViewport.removeEventListener('scroll', updateFromVisualViewport);
    };
  }, []);

  return viewportHeight;
}
