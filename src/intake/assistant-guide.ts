// /contribute/assistant — the "Set up once. Then just talk." walkthrough for
// contributors who hold a bearer token. It used to be an overlay panel in
// /field (#assistant); it lives next to /contribute now so the link from the
// intake page stays in the contribute flow. Black ink on a white card, scoped
// under #assistant-guide so the light theme never leaks into the site chrome.

import { htmlPage } from "../templates.js";

const CSS = `
#assistant-guide {
  --bg:#ffffff; --ink:#161513; --dim:#8d8a82; --faint:#d9d6cd; --box:#fbfaf7; --sel:#161513; --sel-ink:#ffffff;
  font-family: 'SF Mono','SFMono-Regular',Menlo,'DejaVu Sans Mono','Liberation Mono',Consolas,monospace;
  background: var(--bg); color: var(--ink); border: 1px solid var(--faint);
  max-width: 760px; margin: 8px 0 24px;
}
#assistant-guide * { box-sizing: border-box; }
#assistant-guide a { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
#assistant-guide .head { padding: 20px 26px 16px; border-bottom: 1px solid var(--faint); }
#assistant-guide .kicker { color: var(--dim); font-size: 13px; margin: 0 0 10px; }
#assistant-guide h2 { font-size: 21px; font-weight: 700; line-height: 1.3; margin: 0; color: var(--ink); }
#assistant-guide .body { padding: 18px 26px 26px; }
#assistant-guide p { margin: 0 0 13px; font-size: 14px; line-height: 1.62; color: var(--ink); }
#assistant-guide .label { color: var(--dim); text-transform: uppercase; letter-spacing: .07em; font-size: 12px; margin: 20px 0 11px; }
#assistant-guide .step { display: grid; grid-template-columns: 30px 1fr; gap: 4px 13px; margin: 0 0 16px; }
#assistant-guide .step .no { color: var(--dim); font-size: 13px; padding-top: 2px; }
#assistant-guide .step .b { min-width: 0; }
#assistant-guide .step .b p { margin: 0 0 9px; }
#assistant-guide b.k { font-weight: 700; }
#assistant-guide .paste { border: 1px solid var(--faint); padding: 14px 16px; margin: 6px 0 4px; font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
#assistant-guide .paste .u { word-break: break-all; }
#assistant-guide .paste .muted { color: var(--dim); }
#assistant-guide .scr { border: 1px solid var(--faint); background: var(--box); padding: 11px; margin: 8px 0 4px; font-size: 12.5px; }
#assistant-guide .scr .tabs { color: var(--dim); padding: 2px 8px 8px; }
#assistant-guide .scr .tabs b { color: var(--ink); font-weight: 700; }
#assistant-guide .scr .ln { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 5px 8px; color: var(--ink); }
#assistant-guide .scr .ln.dim { color: var(--dim); }
#assistant-guide .scr .ln.small { font-size: 11.5px; }
#assistant-guide .scr .sel { background: var(--sel); color: var(--sel-ink); }
#assistant-guide .scr .sel .hint { color: var(--sel-ink); opacity: .62; }
#assistant-guide .scr .added { color: var(--dim); }
#assistant-guide .scr .rule { border-top: 1px solid var(--faint); margin: 7px 4px; }
#assistant-guide .pill-sel { background: var(--sel); color: var(--sel-ink); padding: 2px 9px; white-space: nowrap; }
#assistant-guide .caret { display: inline-block; width: 7px; margin-left: 1px; background: var(--ink); color: transparent; animation: adaiblink 1.05s steps(1) infinite; }
@keyframes adaiblink { 50% { opacity: 0; } }
#assistant-guide .pills { display: flex; flex-wrap: wrap; gap: 9px; margin: 24px 0 8px; }
#assistant-guide .pill { border: 1px solid var(--faint); color: var(--dim); text-transform: uppercase; letter-spacing: .08em; font-size: 11px; padding: 7px 11px; }
#assistant-guide .off { font-size: 13px; line-height: 1.7; color: var(--ink); margin: 0 0 8px; }
#assistant-guide .off .arrow { color: var(--dim); }
#assistant-guide .closer { color: var(--dim); font-size: 13px; line-height: 1.7; margin: 18px 0 0; border-top: 1px solid var(--faint); padding-top: 15px; }
#assistant-guide .guide { margin: 16px 0 0; display: flex; flex-wrap: wrap; gap: 10px; }
#assistant-guide .guide a {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid var(--ink); color: var(--ink); background: transparent;
  font-family: inherit; font-size: 11px; letter-spacing: 0.08em;
  text-transform: uppercase; padding: 8px 13px; text-decoration: none;
  transition: background 120ms ease, color 120ms ease;
}
#assistant-guide .guide a:hover { background: var(--ink); color: var(--bg); }
@media (max-width: 560px) {
  #assistant-guide .head, #assistant-guide .body { padding-left: 16px; padding-right: 16px; }
  #assistant-guide .step { grid-template-columns: 1fr; }
}
`;

const BODY = `
<div id="assistant-guide">
  <div class="head">
    <p class="kicker">[contribute · setup]</p>
    <h2>Set up once. Then just talk.</h2>
  </div>
  <div class="body">
    <p>Curate A(DAI) in plain language from your own assistant — every edit attributed to you, withdrawable anytime.</p>
    <p class="label">How to set up — about five minutes, just once</p>
    <p>You don't need our UI. You'll connect Claude (or any assistant that can run shell commands with internet access) to A(DAI), then curate by chatting. Seven steps:</p>

    <div class="step"><div class="no">01</div><div class="b"><p>We'll send you a private access token separately — treat it like a password.</p></div></div>

    <div class="step"><div class="no">02</div><div class="b">
      <p><b class="k">Download the skill.</b> Click this link — it saves a zip file to your computer (Downloads is fine). Don't unzip it; Claude takes it as is:</p>
      <div class="paste"><a class="u" href="/adai-contribute.zip" download>https://digitalartsinstitute.io/adai-contribute.zip</a>
<span class="muted">the skill itself, as plain text: <a href="/skill.md">skill.md</a></span></div>
    </div></div>

    <div class="step"><div class="no">03</div><div class="b">
      <p><b class="k">Open Customize.</b> In the Claude app, go to the Cowork tab, then click Customize.</p>
      <div class="scr">
        <div class="tabs">chat &nbsp; [<b>cowork</b>] &nbsp; code</div>
        <div class="ln dim"><span>+&nbsp; new task</span></div>
        <div class="ln dim"><span>projects</span></div>
        <div class="ln dim"><span>artifacts</span></div>
        <div class="ln dim"><span>scheduled</span></div>
        <div class="ln dim"><span>dispatch &nbsp;(beta)</span></div>
        <div class="ln sel"><span>customize</span><span class="hint">&larr; click</span></div>
        <div class="rule"></div>
        <div class="ln dim small"><span>recents</span></div>
        <div class="ln dim small"><span>·&nbsp; adai contribution token</span></div>
      </div>
    </div></div>

    <div class="step"><div class="no">04</div><div class="b">
      <p><b class="k">Allow internet access.</b> On the Capabilities page, switch on network egress and set the domain allowlist to All domains. This is what lets the skill reach the site to save your work.</p>
      <div class="scr">
        <div class="ln"><span>allow network egress</span><span class="pill-sel">ON&nbsp; &larr;</span></div>
        <div class="ln"><span>domain allowlist</span><span class="pill-sel">ALL DOMAINS ▾</span></div>
        <div class="ln dim small"><span>ⓘ&nbsp; claude can access all domains on the internet</span></div>
      </div>
      <p style="color:var(--dim);font-size:13px;margin-top:9px">More cautious? Allow just <b class="k" style="color:var(--ink)">digitalartsinstitute.io</b> — that's the only site the skill needs.</p>
    </div></div>

    <div class="step"><div class="no">05</div><div class="b">
      <p><b class="k">Add the skill.</b> On the same page, under Skills, press +, choose Upload a skill, and pick the adai-contribute.zip you saved.</p>
      <div class="scr">
        <div class="ln"><span>skills</span><span class="pill-sel">+&nbsp; &larr; press</span></div>
        <div class="rule"></div>
        <div class="ln"><span>✓&nbsp; adai-contribute</span><span class="added">added</span></div>
      </div>
    </div></div>

    <div class="step"><div class="no">06</div><div class="b">
      <p><b class="k">Start a task.</b> Back in Cowork, click + New task.</p>
      <div class="scr">
        <div class="tabs">chat &nbsp; [<b>cowork</b>] &nbsp; code</div>
        <div class="ln sel"><span>+&nbsp; new task</span><span class="hint">&larr; click</span></div>
        <div class="ln dim"><span>projects</span></div>
        <div class="ln dim"><span>artifacts</span></div>
      </div>
    </div></div>

    <div class="step"><div class="no">07</div><div class="b">
      <p><b class="k">Run it, then talk.</b> Type /adai-contribute (it autocompletes). Add your token on the same line, or just send it and Claude will ask. Then describe your work in plain language.</p>
      <div class="scr">
        <div class="ln"><span>&gt;&nbsp; /adai-contribute<span class="caret">.</span></span></div>
        <div class="rule"></div>
        <div class="ln sel"><span>/adai-contribute</span><span class="hint">contribute to the A(DAI) commons</span></div>
      </div>
      <div class="paste" style="margin-top:11px">"Add my piece Drift — generative, 2024 — and connect it to the show where it was exhibited."</div>
    </div></div>

    <div class="pills">
      <span class="pill">Attributed to you</span>
      <span class="pill">Withdraw anytime</span>
      <span class="pill">No lock-in</span>
      <span class="pill">Reviewed first</span>
    </div>

    <p class="label">If something's off</p>
    <p class="off"><b class="k">/adai-contribute won't appear</b> <span class="arrow">→</span> redo step 05, and make sure you're inside a Cowork task (not a plain Chat).</p>
    <p class="off"><b class="k">it can't reach the site / can't save</b> <span class="arrow">→</span> redo step 04 — network egress on, allowlist includes digitalartsinstitute.io.</p>
    <p class="off"><b class="k">"pending review"</b> <span class="arrow">→</span> normal for new contributors. Your work is saved and credited, just waiting for a curator.</p>

    <p class="closer">Some connections only you can see: between your work and what shaped it, where it showed, who it spoke to. Draw one, and the field is truer for it.</p>
    <div class="guide">
      <a href="/field-static/guide.html" target="_blank" rel="noopener">Starter guide <span aria-hidden="true">&rarr;</span></a>
      <a href="/contribute">Or give A(DAI) a URL <span aria-hidden="true">&rarr;</span></a>
    </div>
  </div>
</div>
`;

export function assistantGuidePage(): string {
  return htmlPage("Set up your assistant", `<style>${CSS}</style>${BODY}`);
}
