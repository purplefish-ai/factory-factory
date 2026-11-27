# Distribution security

## SQLite in release artifacts

The CLI build bundles the JavaScript from the pinned Prisma SQLite adapter into
`dist/src/backend/lib/sqlite-adapter.js`. Its native dependency,
`better-sqlite3`, stays external so Prisma and migrations open the same driver.
The upstream adapter is a development dependency because its published manifest
still requests v12. The pnpm override aligns source checkouts with the v13
driver shipped to users: two SQLite builds in one process release each other's
POSIX locks on the database file, and v12 needs an install-time native build
that `allowBuilds` does not permit. Keep these paths aligned when upgrading
Prisma or SQLite. The packed-consumer check compares both real paths and runs a
Prisma query against the installed artifact.
