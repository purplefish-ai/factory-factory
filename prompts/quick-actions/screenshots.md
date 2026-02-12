---
name: Take Screenshots
description: Capture screenshots of the running dev app
type: agent
icon: camera
---
Take a screenshot of the workspace's running development app to capture the current state of the UI.

## Step 1: Start the dev server

1. Read `factory-factory.json` in the repo root for the `scripts.run` command
2. Pick a free port and replace `{port}` in the command with it
3. Start the dev server in the background and wait for it to be ready

## Step 2: Take a screenshot

1. `mkdir -p .factory-factory/screenshots`
2. Use `browser_navigate` to visit the dev server URL
3. Determine the most relevant screen that captures the current state of the app
4. Use `browser_screenshot` to capture it
5. Save to `.factory-factory/screenshots/` with a descriptive PNG filename
