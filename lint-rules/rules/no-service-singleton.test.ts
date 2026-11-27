import { describe, expect, it } from 'vitest';
import { describeRuleFixtures, readProjectConfig } from '../testing/rule-fixtures';

const RULE = 'factory/no-service-singleton';
const scopes = readProjectConfig().overrides.filter(
  (override) => override.rules[RULE] !== undefined
);

describe('service singletons', () => {
  it('are rejected under src/backend only', () => {
    expect(scopes.map((override) => [override.files, override.rules[RULE]])).toEqual([
      [['src/backend/**/*.ts'], 'error'],
    ]);
  });
});

const backend = (name: string, source: string) => ({
  file: `src/backend/services/example/${name}.ts`,
  source,
});

// Fixture paths mirror the repository, and `files` applies the project's scope,
// so a file outside src/backend is not linted.
describeRuleFixtures('no-service-singleton', {
  files: scopes.flatMap((override) => override.files),
  rejected: [
    // A class declared in the same file.
    backend(
      'same-file.service',
      'class FooService {}\nexport const fooService = new FooService();'
    ),
    // A class imported from a relative module, and through the alias.
    backend(
      'relative.service',
      "import { FooService } from './foo.service';\nexport const fooService = new FooService({ retries: 1 });"
    ),
    backend(
      'alias.service',
      "import { FooService } from '@/backend/services/foo';\nexport const fooService = new FooService();"
    ),
    // Names are not what matters: an accessor, a store, a cache.
    backend(
      'accessor',
      "import { WorkspaceAccessor } from './workspace.accessor';\nexport const workspaceAccessor = new WorkspaceAccessor();"
    ),
    backend(
      'cache',
      "import { CommandScanCache } from './cache';\nexport const commandScanCache = new CommandScanCache();"
    ),
    // A type annotation, `as`, `satisfies` and generic arguments do not hide it.
    backend(
      'annotated',
      "import { PrismaFooAccessor } from './foo.accessor';\nimport type { FooAccessor } from './types';\nexport const fooAccessor: FooAccessor = new PrismaFooAccessor();"
    ),
    backend(
      'as-cast',
      "import { FooService } from './foo.service';\nexport const fooService = new FooService() as FooService;"
    ),
    backend(
      'satisfies',
      "import { FooService } from './foo.service';\nexport const fooService = new FooService() satisfies FooService;"
    ),
    backend(
      'generic',
      "import { Registry } from './registry';\nexport const registry = new Registry<string>();"
    ),
    // `const` then exported by name, renamed, or by default.
    backend(
      'export-list',
      "import { FooService } from './foo.service';\nconst fooService = new FooService();\nexport { fooService };"
    ),
    backend(
      'export-renamed',
      "import { FooService } from './foo.service';\nconst instance = new FooService();\nexport { instance as fooService };"
    ),
    backend(
      'export-before-declaration',
      "import { FooService } from './foo.service';\nexport { fooService };\nconst fooService = new FooService();"
    ),
    backend(
      'default-new',
      "import { FooService } from './foo.service';\nexport default new FooService();"
    ),
    backend(
      'default-identifier',
      "import { FooService } from './foo.service';\nconst fooService = new FooService();\nexport default fooService;"
    ),
    backend(
      'exported-let',
      "import { FooService } from './foo.service';\nexport let fooService = new FooService();"
    ),
    backend(
      'exported-var',
      "import { FooService } from './foo.service';\nexport var fooService = new FooService();"
    ),
    // A member of a namespace import from a repository module.
    backend(
      'namespace',
      "import * as services from './services';\nexport const fooService = new services.FooService();"
    ),
    // A wrapped default export of an instance.
    backend(
      'default-wrapped',
      "import { FooService } from './foo.service';\nconst fooService = new FooService();\nexport default fooService as FooService;"
    ),
    backend(
      'default-parenthesized',
      "import { FooService } from './foo.service';\nconst fooService = new FooService();\nexport default (fooService);"
    ),
    // One report per instance, even when it is exported twice.
    backend(
      'exported-twice',
      "import { FooService } from './foo.service';\nexport const fooService = new FooService();\nexport { fooService as default };"
    ),
  ],
  accepted: [
    // Built-ins and platform classes are not services.
    backend(
      'built-ins',
      'export const cache = new Map<string, number>();\nexport const seen = new Set<string>();\nexport const owners = new WeakMap<object, string>();\nexport const started = new Date();\nexport const origin = new URL("http://localhost");\nexport const pattern = new RegExp("a");\nexport const controller = new AbortController();\nexport const failure = new Error("failed");'
    ),
    // Classes from packages and from the generated Prisma client are library objects.
    backend(
      'packages',
      "import { PrismaClient } from '@prisma-gen/client';\nimport { AsyncLocalStorage } from 'node:async_hooks';\nimport { Mutex } from 'async-mutex';\nexport const prisma = new PrismaClient();\nexport const storage = new AsyncLocalStorage<string>();\nexport const mutex = new Mutex();"
    ),
    backend('zod', "import { z } from 'zod';\nexport const schema = new z.ZodObject({});"),
    // An error class of the repository is a value, not a service.
    backend(
      'error-class',
      "import { NotFoundError } from './errors';\nclass LocalError extends Error {}\nexport const notFound = new NotFoundError();\nexport const local = new LocalError();"
    ),
    // A namespace import from a package is a library object, as is a member Error class.
    backend(
      'package-namespace',
      "import * as library from 'some-library';\nimport * as errors from './errors';\nexport const client = new library.Client();\nexport const failure = new errors.NotFoundError();"
    ),
    // The pattern the message asks for: the class, and a factory.
    backend(
      'class-and-factory',
      'export class FooService {\n  constructor(readonly dependencies: object) {}\n}\nexport function createFooService(dependencies: object) {\n  return new FooService(dependencies);\n}'
    ),
    // An instance that is not exported, or built inside a function, is not a module global others reach.
    backend(
      'not-exported',
      "import { FooService } from './foo.service';\nconst fooService = new FooService();\nexport function useFoo() { return fooService.run(); }"
    ),
    backend(
      'inside-function',
      "import { FooService } from './foo.service';\nexport function build() { const fooService = new FooService(); return fooService; }\nexport const factory = () => new FooService();"
    ),
    // A type-only import is not a class a `new` can build.
    backend(
      'type-import',
      "import type { FooService } from './foo.service';\nexport const fooService = new FooService();"
    ),
    // Documented limit: a factory call or a frozen object is not detected.
    backend(
      'factory-call',
      "import { createFooService } from './foo.service';\nexport const fooService = createFooService();\nexport const limits = Object.freeze({ max: 1 });"
    ),
    // Tests and test support build instances freely.
    {
      file: 'src/backend/services/example/foo.service.test.ts',
      source:
        "import { FooService } from './foo.service';\nexport const fooService = new FooService();",
    },
    {
      file: 'src/backend/services/example/foo.integration.test.ts',
      source:
        "import { FooService } from './foo.service';\nexport const fooService = new FooService();",
    },
    {
      file: 'src/backend/testing/foo-fixture.ts',
      source:
        "import { FooService } from '../services/example/foo.service';\nexport const fooService = new FooService();",
    },
    {
      file: 'src/backend/orchestration/testing/foo.test-support.ts',
      source:
        "import { FooService } from '../../services/example/foo.service';\nexport const fooService = new FooService();",
    },
    {
      file: 'src/backend/server.test-helpers.ts',
      source:
        "import { FooService } from './services/example/foo.service';\nexport const fooService = new FooService();",
    },
    // Outside src/backend the rule is not enabled.
    {
      file: 'src/client/lib/foo.ts',
      source:
        "import { FooClient } from './foo-client';\nexport const fooClient = new FooClient();",
    },
    {
      file: 'src/cli/foo.ts',
      source:
        "import { FooClient } from './foo-client';\nexport const fooClient = new FooClient();",
    },
  ],
});
