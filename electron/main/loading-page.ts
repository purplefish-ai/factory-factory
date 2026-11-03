// Shown while the backend starts so the window appears immediately. It is a
// self-contained data: URL: no scripts and no remote or file resources, which
// the CSP enforces. The app defaults to its dark theme, so dark is the default
// here too; a light system appearance gets light colors.
const LOADING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="color-scheme" content="dark light">
<title>Factory Factory</title>
<style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:#0a0a0a;color:#a1a1aa;font:14px ui-sans-serif,system-ui,-apple-system,sans-serif;cursor:default;user-select:none}
.spinner{width:24px;height:24px;border:2px solid #3f3f46;border-top-color:#e4e4e7;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-color-scheme:light){body{background:#fff;color:#71717a}.spinner{border-color:#e4e4e7;border-top-color:#3f3f46}}
@media (prefers-reduced-motion:reduce){.spinner{animation-duration:3s}}
</style>
</head>
<body>
<div class="spinner" role="progressbar" aria-label="Starting"></div>
<div>Starting Factory Factory…</div>
</body>
</html>`;

export const LOADING_PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(LOADING_PAGE_HTML)}`;
