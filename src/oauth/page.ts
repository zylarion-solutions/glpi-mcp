/**
 * Sign-in page shown during the OAuth flow. Self-contained, no scripts.
 *
 * The markup is a fixed template with {{placeholders}}; every value is
 * HTML-escaped before it is placed, so nothing from a request can add markup.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en">',
  "<head>",
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex">',
  "<title>Connect to GLPI</title>",
  "<style>",
  "  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --fg:#1d232b; --muted:#5b6673; --line:#d9dee5; --accent:#2f5bd3; --err:#b42318; }",
  "  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --card:#1a1f26; --fg:#e8ecf1; --muted:#9aa5b1; --line:#2d3540; --accent:#7ea2ff; --err:#ff8a80; } }",
  "  * { box-sizing: border-box; }",
  "  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);",
  '         font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding:16px; }',
  "  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }",
  "  h1 { font-size:1.25rem; margin:0 0 4px; }",
  "  p { margin:0 0 16px; color:var(--muted); }",
  "  label { display:block; font-weight:600; margin:8px 0 6px; }",
  "  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; font:inherit; background:transparent; color:inherit; }",
  "  button { width:100%; margin-top:16px; padding:11px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }",
  "  .err { color:var(--err); margin-bottom:12px; }",
  "  .dest { color:var(--fg); background:color-mix(in srgb, var(--accent) 10%, transparent); padding:8px 10px; border-radius:8px; }",
  "  ol { color:var(--muted); padding-left:20px; margin:16px 0 0; font-size:.92rem; }",
  "  a { color:var(--accent); }",
  "  small { display:block; margin-top:16px; color:var(--muted); font-size:.85rem; }",
  "</style>",
  "</head>",
  "<body>",
  "<main>",
  "  <h1>Connect to GLPI</h1>",
  "  <p>{{app}} wants to use GLPI as you, with your own permissions.</p>",
  '  <p class="dest">Access will be given to <b>{{host}}</b>. Continue only if you started this from that app.</p>',
  '  <p class="err" role="alert"{{errorHidden}}>{{error}}</p>',
  '  <form method="post" action="login" autocomplete="off">',
  '    <input type="hidden" name="request" value="{{sealed}}">',
  '    <label for="token">Your GLPI API token</label>',
  '    <input id="token" name="glpi_user_token" type="password" required minlength="20" maxlength="128" spellcheck="false" autofocus>',
  '    <button type="submit">Connect</button>',
  "  </form>",
  "  <ol>",
  '    <li>Open <a href="{{prefs}}" target="_blank" rel="noopener noreferrer">your GLPI settings</a> ({{glpi}}).</li>',
  "    <li>Under <b>Remote access keys</b>, copy the <b>API token</b> (regenerate it if it is empty).</li>",
  "    <li>Paste it above. You can revoke it at any time by regenerating it in GLPI.</li>",
  "  </ol>",
  "  <small>The token is only used to call GLPI on your behalf and is never written to disk in clear text.</small>",
  "</main>",
  "</body>",
  "</html>",
].join("\n");

export function renderLoginPage(opts: {
  sealed: string;
  clientName?: string;
  redirectHost: string;
  glpiUrl: string;
  error?: string;
}): string {
  const values: Record<string, string> = {
    app: escapeHtml(opts.clientName?.slice(0, 80) || "An application"),
    host: escapeHtml(opts.redirectHost),
    error: escapeHtml(opts.error ?? ""),
    errorHidden: opts.error ? "" : " hidden",
    sealed: escapeHtml(opts.sealed),
    prefs: escapeHtml(opts.glpiUrl + "/front/preference.php"),
    glpi: escapeHtml(opts.glpiUrl),
  };
  return TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => values[key] ?? "");
}
