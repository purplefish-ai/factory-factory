// Project rules use Oxlint's ESLint-compatible API, one rule per file in
// rules/. Keep both lists alphabetical; see README.md for adding a rule.
import buttonIconSize from './rules/button-icon-size.mjs';
import buttonSizeVariant from './rules/button-size-variant.mjs';
import focusRing from './rules/focus-ring.mjs';
import iconButtonName from './rules/icon-button-name.mjs';
import iconButtonTooltip from './rules/icon-button-tooltip.mjs';
import namedQueryOptions from './rules/named-query-options.mjs';
import noArbitraryFontSize from './rules/no-arbitrary-font-size.mjs';
import noAwaitImport from './rules/no-await-import.mjs';
import noDirectWebStorage from './rules/no-direct-web-storage.mjs';
import noForwardRef from './rules/no-forward-ref.mjs';
import noNativeDialogs from './rules/no-native-dialogs.mjs';
import noNextDirectives from './rules/no-next-directives.mjs';
import noRawPaletteClasses from './rules/no-raw-palette-classes.mjs';
import noRawSpinner from './rules/no-raw-spinner.mjs';
import noRawTabRole from './rules/no-raw-tab-role.mjs';
import noRenderRefWrite from './rules/no-render-ref-write.mjs';
import noStateSyncEffect from './rules/no-state-sync-effect.mjs';
import noToolInputCast from './rules/no-tool-input-cast.mjs';
import noUnsafeJsonParseCast from './rules/no-unsafe-json-parse-cast.mjs';
import noUnsafeResolverCast from './rules/no-unsafe-resolver-cast.mjs';
import noZodAny from './rules/no-zod-any.mjs';
import queryErrorHandled from './rules/query-error-handled.mjs';
import queryOwner from './rules/query-owner.mjs';
import stableContextValue from './rules/stable-context-value.mjs';
import tooltipProviderRoot from './rules/tooltip-provider-root.mjs';
import usePendingProp from './rules/use-pending-prop.mjs';
import useStatusCallout from './rules/use-status-callout.mjs';

export default {
  meta: { name: 'factory' },
  rules: {
    'button-icon-size': buttonIconSize,
    'button-size-variant': buttonSizeVariant,
    'focus-ring': focusRing,
    'icon-button-name': iconButtonName,
    'icon-button-tooltip': iconButtonTooltip,
    'named-query-options': namedQueryOptions,
    'no-arbitrary-font-size': noArbitraryFontSize,
    'no-await-import': noAwaitImport,
    'no-direct-web-storage': noDirectWebStorage,
    'no-forward-ref': noForwardRef,
    'no-native-dialogs': noNativeDialogs,
    'no-next-directives': noNextDirectives,
    'no-raw-palette-classes': noRawPaletteClasses,
    'no-raw-spinner': noRawSpinner,
    'no-raw-tab-role': noRawTabRole,
    'no-render-ref-write': noRenderRefWrite,
    'no-state-sync-effect': noStateSyncEffect,
    'no-tool-input-cast': noToolInputCast,
    'no-unsafe-json-parse-cast': noUnsafeJsonParseCast,
    'no-unsafe-resolver-cast': noUnsafeResolverCast,
    'no-zod-any': noZodAny,
    'query-error-handled': queryErrorHandled,
    'query-owner': queryOwner,
    'stable-context-value': stableContextValue,
    'tooltip-provider-root': tooltipProviderRoot,
    'use-pending-prop': usePendingProp,
    'use-status-callout': useStatusCallout,
  },
};
