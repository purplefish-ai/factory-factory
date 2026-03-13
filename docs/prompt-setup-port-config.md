Configure this project so FactoryFactory can run it on a dynamically allocated port.

## What to do

1. **Inspect the project** — identify the framework, package manager, and how the dev server is started (check `package.json`, existing config files, `README`).

2. **Update (or create) `factory-factory.json`** at the repo root. Use `{port}` as the port placeholder — FactoryFactory will substitute a free port before launching. Example structure:

   ```json
   {
     "scripts": {
       "run": "<your dev server command> --port {port}",
       "cleanup": "<command to stop the dev server if needed>"
     }
   }
   ```

   Common patterns by framework:
   - **Vite**: `"run": "npx vite --port {port}"`
   - **Next.js**: `"run": "npx next dev --port {port}"`
   - **Create React App**: `"run": "PORT={port} npx react-scripts start"`
   - **Express / Node**: `"run": "PORT={port} node src/index.js"` (or `ts-node`, etc.)
   - **Remix**: `"run": "PORT={port} npx remix dev"`
   - **SvelteKit**: `"run": "npx vite dev --port {port}"`
   - **Astro**: `"run": "npx astro dev --port {port}"`

3. **Make the app actually respect the port** — depending on the framework:
   - If it's a CLI-flag-driven server (Vite, Next, etc.), no app-level changes are needed; the flag handles it.
   - If it's a custom Node/Express/Fastify server, update the listen call to read from `process.env.PORT` with a fallback:
     ```js
     const port = parseInt(process.env.PORT ?? '3000', 10);
     app.listen(port, () => console.log(`Listening on port ${port}`));
     ```
   - If the port is hardcoded anywhere in the codebase (e.g., `fetch('http://localhost:3000/api')`), replace it with a relative path or a runtime-configurable value.

4. **Verify** the `factory-factory.json` is valid JSON, lives at the repo root, and the `run` script would work if `{port}` were replaced with a real number (e.g., `5173`).

Do not add a `setup` script unless one is genuinely needed (e.g., `npm install`). Keep the config minimal and correct.
