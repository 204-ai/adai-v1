// The archivist's budget alert: 80 % warns, the cap says "reached", each at
// most once per UTC day, a failed send is retried by the next chat.

import { it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.js";
import { budgetLevel, maybeAlertBudget } from "../src/archivist/budget-alert.js";
import type { MailMessage } from "../src/utils/mail.js";

const DATE = "2026-10-26";

function spend(db: ReturnType<typeof freshDb>, usd: number) {
  db.prepare(
    `INSERT INTO archivist_usage (date, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, est_cost_usd)
     VALUES (?, 0, 0, 0, 0, ?)
     ON CONFLICT(date) DO UPDATE SET est_cost_usd = excluded.est_cost_usd`
  ).run(DATE, usd);
}

beforeEach(() => {
  process.env.ARCHIVIST_ALERT_EMAILS = "ops@example.org";
});

it("budget alert: levels", () => {
  assert.equal(budgetLevel(1, 25), null);
  assert.equal(budgetLevel(20, 25), "warn");
  assert.equal(budgetLevel(25, 25), "reached");
  assert.equal(budgetLevel(99, 0), null, "a disabled gate never alerts");
});

it("budget alert: warn once, then reached once", async () => {
  const db = freshDb();
  const sent: MailMessage[] = [];
  const send = async (m: MailMessage) => { sent.push(m); return { id: "x", transport: "resend" as const }; };
  const opts = { send, date: DATE, capUsd: 25 };

  spend(db, 5);
  assert.equal(await maybeAlertBudget(db, opts), null);
  spend(db, 21);
  assert.equal(await maybeAlertBudget(db, opts), "warn");
  assert.equal(await maybeAlertBudget(db, opts), null, "warning sent once");
  spend(db, 25.4);
  assert.equal(await maybeAlertBudget(db, opts), "reached");
  assert.equal(await maybeAlertBudget(db, opts), null, "reached sent once");

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.to, ["ops@example.org"]);
  assert.match(sent[0]!.subject, /84% of today's budget/);
  assert.match(sent[1]!.subject, /budget reached: \$25\.40 of \$25\.00/);
  assert.equal(sent[1]!.idempotencyKey, `archivist-budget-${DATE}-reached`);
});

it("budget alert: straight past 80 % sends only 'reached'", async () => {
  const db = freshDb();
  const sent: MailMessage[] = [];
  const send = async (m: MailMessage) => { sent.push(m); return { id: "x", transport: "resend" as const }; };
  spend(db, 30);
  assert.equal(await maybeAlertBudget(db, { send, date: DATE, capUsd: 25 }), "reached");
  assert.equal(await maybeAlertBudget(db, { send, date: DATE, capUsd: 25 }), null);
  assert.equal(sent.length, 1);
});

it("budget alert: a failed send is retried by the next chat", async () => {
  const db = freshDb();
  let calls = 0;
  const flaky = async (_m: MailMessage) => {
    calls++;
    if (calls === 1) throw new Error("Resend down");
    return { id: "x", transport: "resend" as const };
  };
  spend(db, 21);
  assert.equal(await maybeAlertBudget(db, { send: flaky, date: DATE, capUsd: 25 }), null);
  assert.equal(await maybeAlertBudget(db, { send: flaky, date: DATE, capUsd: 25 }), "warn");
  assert.equal(calls, 2);
});

it("budget alert: nobody to tell, nothing claimed", async () => {
  const db = freshDb();
  delete process.env.ARCHIVIST_ALERT_EMAILS;
  const saved = process.env.ADMIN_NOTIFY_EMAILS;
  delete process.env.ADMIN_NOTIFY_EMAILS;
  try {
    spend(db, 30);
    let sent = 0;
    const send = async (_m: MailMessage) => { sent++; return { id: "x", transport: "resend" as const }; };
    assert.equal(await maybeAlertBudget(db, { send, date: DATE, capUsd: 25 }), null);
    assert.equal(sent, 0);
    const claims = db.prepare("SELECT count(*) n FROM settings WHERE key LIKE 'archivist_budget_alert:%'").get() as { n: number };
    assert.equal(claims.n, 0);
  } finally {
    if (saved !== undefined) process.env.ADMIN_NOTIFY_EMAILS = saved;
  }
});
