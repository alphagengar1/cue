import "./_env.js";
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { findOrg, findStoredPerson, parseTranscript } from "../src/parse.js";
import { store } from "../src/store.js";
import { dataFile } from "./_helpers.js";

// Career fair pack: Anduril (alias "Anduril Industries"), Cloudflare, Vercel; Priya Shah, Alex Kim.
describe("parseTranscript (career fair pack)", () => {
  before(() => { store.loadSample(dataFile("creao-career-fair.json")); });

  test("comma form: name, org, role", () => {
    assert.deepEqual(parseTranscript("Priya, Anduril, recruiter"), { name: "Priya", org: "Anduril", role: "recruiter" });
  });
  test("comma form: missing role", () => {
    assert.deepEqual(parseTranscript("Priya Shah, Anduril."), { name: "Priya Shah", org: "Anduril" });
  });
  test("comma form: trailing punctuation and extra spaces", () => {
    assert.deepEqual(parseTranscript("  Priya ,  Anduril ,  recruiter. "), { name: "Priya", org: "Anduril", role: "recruiter" });
  });
  test("no commas, known org alias, role after", () => {
    assert.deepEqual(parseTranscript("Priya Anduril Industries recruiter"),
      { name: "Priya", org: "Anduril Industries", role: "recruiter" });
  });
  test("lowercase transcript still finds the org", () => {
    const q = parseTranscript("priya anduril recruiter");
    assert.equal(q.org, "anduril");
    assert.equal(findOrg(q.org)?.id, "anduril");
  });
  test("4+ comma parts fall back to org search", () => {
    const q = parseTranscript("Alex Kim, Cloudflare, speaker, edge");
    assert.equal(q.name, "Alex Kim");
    assert.equal(findOrg(q.org)?.id, "cloudflare");
  });
  test("filler words before the name are dropped", () => {
    assert.deepEqual(parseTranscript("um this is Alex Kim from Cloudflare"), { name: "Alex Kim", org: "Cloudflare" });
  });
  test("filler words: org still resolves (what the demo relies on today)", () => {
    const q = parseTranscript("um this is Alex Kim from Cloudflare");
    assert.equal(findOrg(q.org)?.id, "cloudflare");
  });
  test("'<name> from <org>' does not leak 'from' into the name", () => {
    assert.equal(parseTranscript("priya from anduril").name, "priya");
  });
  test("comma inside the intro: known org wins over the comma split", () => {
    assert.deepEqual(parseTranscript("Priya Sharma, recruiter at Anduril"), { name: "Priya Sharma", org: "Anduril", role: "recruiter" });
  });
  test("leading greeting part before a comma is dropped (unknown org)", () => {
    assert.equal(parseTranscript("Hi, Dana, Stripe").name, "Dana");
  });
  test("unknown org comma form: 'recruiter at X' -> role + org", () => {
    assert.deepEqual(parseTranscript("Dana Wu, recruiter at Stripe"), { name: "Dana Wu", org: "Stripe", role: "recruiter" });
  });
  test("unknown org, no commas: first word name, last word role (rule 3)", () => {
    assert.deepEqual(parseTranscript("Jordan Sentry developer advocate"),
      { name: "Jordan", org: "Sentry developer", role: "advocate" });
  });
  test("single word: name only, no org", () => {
    assert.deepEqual(parseTranscript("Maya"), { name: "Maya", org: "" });
  });
  test("empty / punctuation only: empty name", () => {
    assert.equal(parseTranscript("").name, "");
    assert.equal(parseTranscript(" ... ?").name, "");
  });
});

// Sample pack (server default): Even Realities (aliases Even, EvenRealities...), CREAO, Photon, Sentry (Sentry.io).
describe("parseTranscript (sample pack)", () => {
  before(() => { store.loadSample(dataFile("sample-event.json")); });

  test("smoke-test phrase without commas", () => {
    assert.deepEqual(parseTranscript("Jordan Sentry developer advocate"),
      { name: "Jordan", org: "Sentry", role: "developer advocate" });
  });
  test("lowercase", () => {
    assert.deepEqual(parseTranscript("jordan sentry developer advocate"),
      { name: "jordan", org: "sentry", role: "developer advocate" });
  });
  test("full name before a multi-word org", () => {
    assert.deepEqual(parseTranscript("Sam Park CREAO engineer"), { name: "Sam Park", org: "CREAO", role: "engineer" });
  });
  test("short alias resolves", () => {
    const q = parseTranscript("Maya Even");
    assert.equal(q.name, "Maya");
    assert.equal(findOrg(q.org)?.id, "even-realities");
  });
  test("longest alias wins (Even Realities G2 over Even)", () => {
    const q = parseTranscript("Maya Even Realities G2 devrel");
    assert.deepEqual(q, { name: "Maya", org: "Even Realities G2", role: "devrel" });
  });
  test("dotted alias 'Sentry.io' is matched whole", () => {
    assert.deepEqual(parseTranscript("Jordan Lee Sentry.io"), { name: "Jordan Lee", org: "Sentry.io" });
  });
  test("Deepgram smart_format style intro with comma", () => {
    const q = parseTranscript("Hi, I'm Maya from Even Realities.");
    assert.equal(findOrg(q.org)?.id, "even-realities");
    assert.equal(q.name, "Maya");
  });
});

describe("findOrg / findStoredPerson", () => {
  before(() => { store.loadSample(dataFile("sample-event.json")); });

  test("exact name, id, alias, case and punctuation insensitive", () => {
    assert.equal(findOrg("Sentry")?.id, "sentry");
    assert.equal(findOrg("sentry.io")?.id, "sentry");
    assert.equal(findOrg("GETSENTRY")?.id, "sentry");
    assert.equal(findOrg("even-realities")?.id, "even-realities");
    assert.equal(findOrg("Even Realities")?.id, "even-realities");
  });
  test("fuzzy match tolerates a typo", () => {
    assert.equal(findOrg("Sentri")?.id, "sentry");
    assert.equal(findOrg("Creo")?.id, "creao");
  });
  test("unrelated and empty org -> null", () => {
    assert.equal(findOrg("Nonexistent Widgets Corp"), null);
    assert.equal(findOrg(""), null);
  });
  test("first-name expansion when unique at the org", () => {
    assert.equal(findStoredPerson("Jordan", findOrg("Sentry"))?.name, "Jordan Lee");
    assert.equal(findStoredPerson("maya", findOrg("Even"))?.name, "Maya Chen");
  });
  test("search guesses saved as Person records are not 'stored'; confirmed ones are", () => {
    const guess = store.upsertPerson("lahacks-f26", "photon", "Zed Guess", { match: "medium", matchReason: "1 search result" });
    assert.equal(findStoredPerson("Zed", findOrg("Photon")), null);
    store.putPerson({ ...guess, confirmed: true });
    assert.equal(findStoredPerson("Zed", findOrg("Photon"))?.name, "Zed Guess");
  });
  test("no expansion across orgs, or for a different full name", () => {
    assert.equal(findStoredPerson("Jordan", findOrg("CREAO")), null);
    assert.equal(findStoredPerson("Jordan Smith", findOrg("Sentry")), null);
    assert.equal(findStoredPerson("Jordan", null), null);
  });
});
