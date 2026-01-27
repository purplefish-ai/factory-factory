import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { getDatabaseUrl } from './src/backend/lib/env';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: getDatabaseUrl(),
  },
});
