// Staging switches (src/utils/staging.ts): prod is untouched, staging is off
// by default per integration, and the mail switch routes recipients.

import { it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { isStaging, switches, switchOn, geminiKey, mailRoute, publicSwitches, stagingBanner } from "../src/utils/staging.js";
import { isR2Configured } from "../src/r2.js";

const saved = { ADAI_ENV: process.env.ADAI_ENV, STAGING_SWITCHES: process.env.STAGING_SWITCHES, GEMINI_API_KEY: process.env.GEMINI_API_KEY };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function env(adaiEnv: string | undefined, sw?: string) {
  if (adaiEnv === undefined) delete process.env.ADAI_ENV;
  else process.env.ADAI_ENV = adaiEnv;
  if (sw === undefined) delete process.env.STAGING_SWITCHES;
  else process.env.STAGING_SWITCHES = sw;
}

it("staging: on prod every integration is on and mail goes to everyone", () => {
  env(undefined, "worker=off mail=stdout");
  process.env.GEMINI_API_KEY = "k";
  assert.equal(isStaging(), false);
  for (const s of ["worker", "r2", "gemini", "archivist"] as const) assert.equal(switchOn(s), true);
  assert.equal(geminiKey(), "k");
  assert.deepEqual(mailRoute(["a@x.y"]), { live: ["a@x.y"], held: [] });
  assert.equal(stagingBanner(), "");
});

it("staging: defaults hold every outward integration but the archivist", () => {
  env("staging");
  process.env.GEMINI_API_KEY = "k";
  assert.deepEqual(switches(), { mail: "stdout", worker: "off", r2: "off", gemini: "off", archivist: "on", activity: "off", data: "nightly" });
  assert.equal(switchOn("worker"), false);
  assert.equal(switchOn("r2"), false);
  assert.equal(switchOn("archivist"), true);
  assert.equal(geminiKey(), null);
  assert.equal(isR2Configured(), false);
  assert.deepEqual(mailRoute(["a@x.y"]), { live: [], held: ["a@x.y"] });
});

it("staging: switches flip per session; unknown ones are ignored", () => {
  env("staging", "worker=on gemini=on archivist=off data=keep bogus=1");
  process.env.GEMINI_API_KEY = "k";
  assert.equal(switchOn("worker"), true);
  assert.equal(geminiKey(), "k");
  assert.equal(switchOn("archivist"), false);
  assert.equal(switches().data, "keep");
  assert.equal("bogus" in switches(), false);
});

it("staging: the mail allowlist takes addresses and @domains, case-insensitively", () => {
  env("staging", "mail=allowlist:Irina@X.y,@team.org");
  assert.deepEqual(mailRoute(["irina@x.y", "b@team.org", "c@else.org"]), { live: ["irina@x.y", "b@team.org"], held: ["c@else.org"] });
  assert.equal(publicSwitches().mail, "allowlist (2)");
  assert.doesNotMatch(stagingBanner(), /irina|team\.org/i);
  env("staging", "mail=live");
  assert.deepEqual(mailRoute(["c@else.org"]), { live: ["c@else.org"], held: [] });
});
