import { EventSchemas, Inngest } from 'inngest';
import type { Events } from './events';

export const inngest = new Inngest({
  id: 'factoryfactory',
  name: 'FactoryFactory',
  schemas: new EventSchemas().fromRecord<Events>(),
});
