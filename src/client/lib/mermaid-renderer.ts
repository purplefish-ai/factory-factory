import mermaid, { type MermaidConfig } from 'mermaid';
import { contrastRatio, parseThemeColor } from '@/client/lib/color-contrast';

/** Mermaid's color utilities require sRGB hex rather than CSS variables/OKLCH. */
export function mermaidThemeConfig(element: HTMLElement): MermaidConfig {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Unable to resolve diagram theme colors');
  }
  const probe = document.createElement('span');
  element.appendChild(probe);
  const color = (token: string, tint?: number) => {
    probe.style.color = tint
      ? `color-mix(in srgb, var(--${token}) ${tint}%, var(--background))`
      : `var(--${token})`;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(probe).color;
    context.fillRect(0, 0, 1, 1);
    const channels = context.getImageData(0, 0, 1, 1).data;
    return `#${Array.from(channels.slice(0, 3), (channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  };
  try {
    const background = color('background');
    const foreground = color('foreground');
    const surface = color('card');
    const muted = color('muted');
    const border = color('ring');
    const categories = ['brand', 'info', 'success', 'warning', 'merged', 'destructive'];
    const minimumContrast =
      document.documentElement.dataset.colorScheme === 'high-contrast' ? 7 : 4.5;
    const parsedForeground = parseThemeColor(foreground);
    const scaleColors = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const token = categories[index % categories.length] ?? 'muted';
        let tint = index < 6 ? 10 : 20;
        let fill = color(token, tint);
        let parsedFill = parseThemeColor(fill);
        // Solarized text has little contrast headroom. Reduce categorical tints
        // until their labels remain readable, retaining the active preset hue.
        while (
          parsedForeground &&
          parsedFill &&
          contrastRatio(parsedForeground.rgb, parsedFill.rgb) < minimumContrast &&
          tint > 0
        ) {
          tint -= 2;
          fill = tint ? color(token, tint) : background;
          parsedFill = parseThemeColor(fill);
        }
        return [`cScale${index}`, fill];
      })
    );
    const scaleLabels = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`cScaleLabel${index}`, foreground])
    );
    return {
      startOnLoad: false,
      theme: 'base',
      look: 'classic',
      layout: 'dagre',
      securityLevel: 'strict',
      suppressErrorRendering: true,
      // Diagram frontmatter/directives must not bypass the app's theme or security.
      secure: [
        ...(mermaid.mermaidAPI.defaultConfig.secure ?? []),
        'theme',
        'themeVariables',
        'themeCSS',
      ],
      themeVariables: {
        darkMode: element.closest('.dark') !== null,
        background,
        primaryColor: surface,
        primaryTextColor: foreground,
        primaryBorderColor: border,
        secondaryColor: muted,
        secondaryTextColor: foreground,
        secondaryBorderColor: border,
        tertiaryColor: background,
        tertiaryTextColor: foreground,
        tertiaryBorderColor: border,
        textColor: foreground,
        lineColor: foreground,
        mainBkg: surface,
        nodeBorder: border,
        clusterBkg: muted,
        clusterBorder: border,
        titleColor: foreground,
        edgeLabelBackground: background,
        nodeTextColor: foreground,
        actorBkg: surface,
        actorBorder: border,
        actorTextColor: foreground,
        actorLineColor: foreground,
        signalColor: foreground,
        signalTextColor: foreground,
        labelBoxBkgColor: surface,
        labelBoxBorderColor: border,
        labelTextColor: foreground,
        loopTextColor: foreground,
        noteBkgColor: surface,
        noteTextColor: foreground,
        noteBorderColor: border,
        activationBkgColor: muted,
        activationBorderColor: border,
        stateBkg: surface,
        stateLabelColor: foreground,
        compositeBackground: muted,
        compositeTitleBackground: surface,
        compositeBorder: border,
        altBackground: background,
        arrowheadColor: foreground,
        defaultLinkColor: foreground,
        specialStateColor: foreground,
        transitionColor: foreground,
        transitionLabelColor: foreground,
        innerEndBackground: foreground,
        classText: foreground,
        labelBackgroundColor: background,
        sectionBkgColor: muted,
        altSectionBkgColor: background,
        sectionBkgColor2: muted,
        excludeBkgColor: muted,
        taskBkgColor: surface,
        taskBorderColor: border,
        activeTaskBkgColor: muted,
        activeTaskBorderColor: color('running'),
        doneTaskBkgColor: muted,
        doneTaskBorderColor: color('success'),
        critBkgColor: surface,
        critBorderColor: color('destructive'),
        todayLineColor: color('info'),
        gridColor: border,
        taskTextColor: foreground,
        taskTextOutsideColor: foreground,
        taskTextLightColor: foreground,
        taskTextDarkColor: foreground,
        taskTextClickableColor: foreground,
        pieTitleTextColor: foreground,
        pieSectionTextColor: foreground,
        pieLegendTextColor: foreground,
        pieStrokeColor: border,
        pieOuterStrokeColor: border,
        ...scaleColors,
        ...scaleLabels,
        ...Object.fromEntries(
          Array.from({ length: 12 }, (_, index) => [
            `pie${index + 1}`,
            scaleColors[`cScale${index}`],
          ])
        ),
      },
    };
  } finally {
    probe.remove();
  }
}

let renderQueue: Promise<unknown> = Promise.resolve();
let nextId = 0;

/** Initialize and render as one queued operation: Mermaid owns global config. */
export function renderThemedMermaid(chart: string, element: HTMLElement, cancelled: () => boolean) {
  const render = renderQueue.then(async () => {
    if (cancelled()) {
      return null;
    }
    mermaid.initialize(mermaidThemeConfig(element));
    const scratch = document.createElement('div');
    scratch.dataset.mermaidRender = '';
    scratch.style.position = 'absolute';
    scratch.style.visibility = 'hidden';
    const width = element.clientWidth || element.parentElement?.clientWidth;
    if (width) {
      scratch.style.width = `${width}px`;
    }
    document.body.appendChild(scratch);
    try {
      const { svg } = await mermaid.render(`mermaid-${++nextId}`, chart, scratch);
      return svg;
    } finally {
      scratch.remove();
    }
  });
  // Failed/incomplete streaming charts must not block later diagrams.
  renderQueue = render.catch(() => undefined);
  return render;
}
