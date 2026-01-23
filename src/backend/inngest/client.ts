import { Inngest, EventSchemas } from 'inngest';
import { Events } from './events';

export const inngest = new Inngest({
  id: 'factoryfactory',
  name: 'FactoryFactory',
  schemas: new EventSchemas().fromRecord<Events>(),
});
