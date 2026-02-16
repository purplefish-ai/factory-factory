---
name: Take Screenshots
description: Capture screenshots of the running dev app
type: agent
icon: camera
---
Take exactly one screenshot of the workspace's running development app to capture the current state of the UI.

## Step 1: Start the dev server

1. Read `factory-factory.json` in the repo root for the `scripts.run` command
2. Pick a free port and replace `{port}` in the command with it
3. Start the dev server in the background with `BROWSER=none` set in the environment (do NOT open a browser window) and wait for it to be ready

## Step 2: Take a single screenshot

1. `mkdir -p .factory-factory/screenshots`
2. Use `browser_navigate` to visit the dev server URL
3. Use `browser_screenshot` to capture the page
4. Save to `.factory-factory/screenshots/` with a descriptive PNG filename

## Step 3: Clean up

1. Kill the dev server process you started in Step 1
2. Close any browser pages you opened

Do not take more than one screenshot. Do not open extra browser tabs or windows.
