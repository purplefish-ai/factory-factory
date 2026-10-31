import * as React from 'react';

export const MOBILE_BREAKPOINT = 768;

export function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return window.innerWidth < breakpoint;
  });

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < breakpoint);
    };

    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
    } else {
      mql.addListener(onChange);
    }

    setIsMobile(window.innerWidth < breakpoint);

    return () => {
      if (typeof mql.removeEventListener === 'function') {
        mql.removeEventListener('change', onChange);
      } else {
        mql.removeListener(onChange);
      }
    };
  }, [breakpoint]);

  return isMobile;
}
