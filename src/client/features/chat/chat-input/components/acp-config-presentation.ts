import { BrainIcon } from '@phosphor-icons/react/dist/csr/Brain';
import { GaugeIcon } from '@phosphor-icons/react/dist/csr/Gauge';
import { HandPalmIcon } from '@phosphor-icons/react/dist/csr/HandPalm';
import { MapTrifoldIcon } from '@phosphor-icons/react/dist/csr/MapTrifold';
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { ShieldIcon } from '@phosphor-icons/react/dist/csr/Shield';
import { ShieldCheckIcon } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { ShieldWarningIcon } from '@phosphor-icons/react/dist/csr/ShieldWarning';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { ToggleLeftIcon } from '@phosphor-icons/react/dist/csr/ToggleLeft';
import type { AcpConfigOption } from '@/client/features/chat/reducer';

export function getConfigPresentation(option: AcpConfigOption) {
  const matches = (...names: string[]) =>
    names.includes(option.id) || names.includes(option.category ?? '');
  if (matches('mode')) {
    const warning = [
      'agent-full-access',
      'bypassPermissions',
      'dangerouslySkipPermissions',
      'dangerousSkipPermissions',
    ].includes(option.currentValue);
    const icons = {
      'read-only': HandPalmIcon,
      default: HandPalmIcon,
      'workspace-write': PencilSimpleIcon,
      acceptEdits: PencilSimpleIcon,
      agent: ShieldCheckIcon,
      auto: ShieldCheckIcon,
      plan: MapTrifoldIcon,
    };
    const icon = warning
      ? ShieldWarningIcon
      : (Object.entries(icons).find(([value]) => value === option.currentValue)?.[1] ?? ShieldIcon);
    return {
      label: 'Access',
      toggle: false,
      icon,
      compact: true,
      active: option.currentValue === 'plan',
      warning,
    };
  }
  if (matches('collaboration_mode', 'plan_mode')) {
    return {
      label: 'Planning',
      toggle: true,
      icon: MapTrifoldIcon,
      compact: true,
      active: option.currentValue === 'plan',
      warning: false,
    };
  }
  if (matches('fast-mode', 'fast')) {
    return {
      label: 'Fast mode',
      toggle: true,
      icon: GaugeIcon,
      compact: true,
      active: option.currentValue === 'on',
      warning: false,
    };
  }
  if (matches('reasoning_effort', 'reasoning', 'effort', 'thought_level')) {
    return {
      label: 'Reasoning effort',
      toggle: false,
      icon: BrainIcon,
      compact: false,
      active: false,
      warning: false,
    };
  }
  // ACP's select fallback for boolean settings advertises on/off values.
  // Render those directly, including new provider settings without a local registry.
  const values = option.options.flatMap((entry) =>
    'group' in entry ? entry.options.map((item) => item.value) : [entry.value]
  );
  const toggle =
    ['on', 'off'].includes(option.currentValue) &&
    values.every((value) => value === 'on' || value === 'off');
  return {
    toggle,
    label: option.name,
    icon: toggle ? (option.id === 'ultracode' ? SparkleIcon : ToggleLeftIcon) : undefined,
    compact: toggle,
    active: toggle && option.currentValue === 'on',
    warning: false,
  };
}
