import { describe, expect, it } from 'vitest';
import { createActionFromWebSocketMessage } from './index';

describe('config option updates', () => {
  it('keeps select controls when an update also includes boolean config options', () => {
    const select = {
      id: 'model',
      name: 'Model',
      type: 'select',
      currentValue: 'sonnet',
      options: [{ value: 'sonnet', name: 'Sonnet' }],
    };
    const action = createActionFromWebSocketMessage({
      type: 'config_options_update',
      configOptions: [select, { id: 'fast', name: 'Fast', type: 'boolean', currentValue: false }],
    });
    expect(action).toEqual({ type: 'CONFIG_OPTIONS_UPDATE', payload: { configOptions: [select] } });
  });
});
