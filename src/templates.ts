export const CSS = `\
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: #0a0a0a; color: #d4d4d4;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 16px; line-height: 1.6;
}
a { color: #7eb8da; text-decoration: none; }
a:hover { text-decoration: underline; }
.wrap { max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem; }
header { border-bottom: 1px solid #222; padding-bottom: 1rem; margin-bottom: 2rem; }
header h1 { font-size: 1.1rem; letter-spacing: 0.05em; }
header h1 span { color: #666; }
header nav { margin-top: 0.5rem; font-size: 0.9rem; }
header nav a { margin-right: 1.2rem; color: #888; }
header nav a:hover { color: #d4d4d4; }
h2 { font-size: 1.3rem; color: #e8e8e8; margin: 1.8rem 0 0.8rem; }
h3 { font-size: 1rem; color: #aaa; margin: 1.2rem 0 0.4rem; font-family: 'SF Mono', 'Fira Code', monospace; }
p { margin-bottom: 0.8rem; }
.tag {
  display: inline-block; background: #1a1a2e; color: #7eb8da;
  padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.8rem;
  margin: 0.15rem 0.2rem 0.15rem 0; font-family: 'SF Mono', 'Fira Code', monospace;
}
.meta { color: #666; font-size: 0.85rem; }
.card {
  border: 1px solid #1a1a1a; padding: 1rem; margin-bottom: 0.8rem;
  border-radius: 4px; background: #0f0f0f;
}
.card:hover { border-color: #333; }
.card h3 { margin: 0 0 0.3rem; }
.card .meta { margin-top: 0.3rem; }
.edge-list { list-style: none; }
.edge-list li { padding: 0.3rem 0; border-bottom: 1px solid #111; font-size: 0.9rem; }
.edge-list li .edge-type {
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.75rem;
  color: #555; margin-right: 0.5rem;
}
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin: 1rem 0; }
.stat-box { background: #0f0f0f; border: 1px solid #1a1a1a; padding: 1.2rem; border-radius: 4px; text-align: center; }
.stat-box .num { font-size: 2rem; color: #e8e8e8; font-family: 'SF Mono', 'Fira Code', monospace; }
.stat-box .label { font-size: 0.8rem; color: #666; margin-top: 0.3rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #1a1a1a; color: #444; font-size: 0.8rem; }
form label { display: block; color: #aaa; font-size: 0.85rem; margin: 1rem 0 0.3rem; font-family: 'SF Mono', 'Fira Code', monospace; }
form input, form select, form textarea {
  width: 100%; background: #111; border: 1px solid #222; color: #d4d4d4;
  padding: 0.5rem 0.7rem; border-radius: 3px; font-size: 0.95rem;
  font-family: inherit;
}
form input:focus, form select:focus, form textarea:focus { border-color: #7eb8da; outline: none; }
form textarea { min-height: 120px; resize: vertical; }
.btn {
  display: inline-block; padding: 0.5rem 1.2rem; border: 1px solid #333;
  border-radius: 3px; background: #1a1a2e; color: #7eb8da; cursor: pointer;
  font-size: 0.9rem; margin: 0.3rem 0.3rem 0 0;
}
.btn:hover { background: #222; border-color: #7eb8da; }
.btn-approve { border-color: #2a5a3a; color: #6fbf8a; }
.btn-approve:hover { background: #1a2e1a; }
.btn-reject { border-color: #5a2a2a; color: #bf6f6f; }
.btn-reject:hover { background: #2e1a1a; }
.status-pending { color: #c4a944; }
.status-approved { color: #6fbf8a; }
.status-rejected { color: #bf6f6f; }
.msg { padding: 1rem; border-radius: 4px; margin: 1rem 0; }
.msg-ok { background: #0f1f0f; border: 1px solid #2a5a3a; color: #6fbf8a; }
.msg-err { background: #1f0f0f; border: 1px solid #5a2a2a; color: #bf6f6f; }`;

// NB: do NOT add `Connection: "close"` here. It was cargo-culted from the
// original MVP port and forces a fresh TCP connection per request (no keep-alive
// reuse). Chrome tolerates it; Safari — which manages its 6-connections-per-host
// pool assuming keep-alive — fills the pool with closing sockets and DEADLOCKS
// (field/embedding fetches hang for minutes). Keep-alive (the HTTP/1.1 default,
// already used by the /api/graph/stream endpoint) is correct and fixes Safari.
export const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
} as const;

export const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `fieldNode`: on a page about one node, the nav's Field opens the field on it. */
export function htmlPage(title: string, body: string, head = "", opts: { fieldNode?: string } = {}): string {
  const fieldHref = opts.fieldNode ? `/field?node=${encodeURIComponent(opts.fieldNode)}` : "/";
  return `<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>${title} — A(DAI)</title><style>${CSS}</style>${head}</head><body><div class='wrap'><header><h1>A<span>(DAI)</span></h1><nav><a href='${htmlEscape(fieldHref)}'>Field</a><a href='/contribute'>Contribute</a><a href='/me'>Me</a><a href='/whitepaper'>Whitepaper</a><a href='/review'>Review</a><a href='/api/stats'>Stats</a></nav></header>${body}<footer>A(DAI) — a digital arts institute convening the digital arts knowledge commons</footer></div></body></html>`;
}
