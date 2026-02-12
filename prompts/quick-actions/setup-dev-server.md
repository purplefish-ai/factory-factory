---
name: Setup Dev Server
description: Configure factory-factory.json to enable the play button
type: agent
icon: play
---
I need to set up a dev server configuration for this workspace.

Please help me create a `factory-factory.json` file in the project root with the appropriate scripts. Follow these steps:

1. First, check if a `factory-factory.json` file already exists in the project root
2. If it exists, show me its contents and ask if I want to modify it
3. If it doesn't exist, analyze the project to determine the appropriate commands:
   - Check for `package.json` and look for common dev server scripts (dev, start, serve)
   - Check for common framework patterns (Next.js, Vite, React, etc.)
   - Check for other build tool configs (Cargo.toml for Rust, go.mod for Go, etc.)
4. Create or update the `factory-factory.json` with:
   - `scripts.setup`: Command to install dependencies (if needed)
   - `scripts.run`: Command to start the dev server (use `{port}` placeholder if the command needs a port)
   - `scripts.cleanup`: Command to clean up resources when stopping (if needed)

Example for a Node.js project:
```json
{
  "scripts": {
    "setup": "npm install",
    "run": "npm run dev",
    "cleanup": "pkill -f 'node.*dev'"
  }
}
```

Example for a project that needs a port:
```json
{
  "scripts": {
    "run": "npm run dev -- --port {port}"
  }
}
```

After creating/updating the file:
1. Commit the changes with a descriptive message
2. Explain that the workspace needs to be restarted for the play button to appear
3. Note that the play button will be available in the workspace header to start/stop the dev server
