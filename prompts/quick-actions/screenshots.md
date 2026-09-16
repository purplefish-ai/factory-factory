---
name: Take Screenshots
description: Capture screenshots of the running dev app
type: agent
icon: camera
---

Capture one representative screenshot of the workspace's development app and
save it under `.factory-factory/screenshots/` with a descriptive PNG filename,
creating the directory if needed. Reuse a running server if available; otherwise
start it using `scripts.run` in `factory-factory.json`, replacing `{port}` with
a free port. Use the available browser tools, and clean up only the server and
browser resources you started. Return the image path, or explain what prevented
capture.
