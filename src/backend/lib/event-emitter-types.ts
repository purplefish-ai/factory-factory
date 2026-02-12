import type { EventEmitter } from 'node:events';

export type EventEmitterListener = Parameters<EventEmitter['on']>[1];
export type EventEmitterEmitArgs =
  Parameters<EventEmitter['emit']> extends [unknown, ...infer Args] ? Args : never;
