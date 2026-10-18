import "./_env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { filterResults, fullNamesIn, resultsToFacts, type SearchResult } from "../src/search.js";

const r = (title: string, text: string, url = "https://example.com/" + title.length): SearchResult => ({ title, url, text });

describe("filterResults: whole words, no common-word aliases", () => {
  const labels = ["Even Realities", "Even", "EvenRealities"];
  test("alias 'Even' alone does not match 'even though'", () => {
    assert.equal(filterResults([r("Maya Chen blog", "Maya Chen kept shipping even though it rained.")], "Maya Chen", labels).length, 0);
  });
  test("org name still matches", () => {
    assert.equal(filterResults([r("Maya Chen", "Maya Chen leads devrel at Even Realities.")], "Maya Chen", labels).length, 1);
  });
  test("name must be a whole word ('Sam' is not 'Samsung')", () => {
    assert.equal(filterResults([r("Samsung at CREAO", "Samsung partners with CREAO.")], "Sam", ["CREAO"]).length, 0);
    assert.equal(filterResults([r("Sam at CREAO", "Sam builds agents at CREAO.")], "Sam", ["CREAO"]).length, 1);
  });
});

describe("fullNamesIn", () => {
  test("headline words are not surnames; first name matches case-insensitively", () => {
    const names = fullNamesIn([r("Priya Speaks at ROSCon", "Priya Shah of Anduril. PRIYA Shah again."), r("x", "Priya Patel at Anduril")], "priya");
    assert.deepEqual(names.sort(), ["priya Patel", "priya Shah"]);
  });
});

describe("resultsToFacts: skips nav / boilerplate sentences", () => {
  test("'Skip to main content' is not the fact", () => {
    const [f] = resultsToFacts([r("Team", "Skip to main content. Priya Shah leads university recruiting at Anduril.", "https://anduril.com/team")]);
    assert.equal(f.text, "Priya Shah leads university recruiting at Anduril.");
  });
});

describe("misheard surnames across events", () => {
  test("a listed attendee from another loaded event still matches within 2 edits", async () => {
    const { findListedPersonByName } = await import("../src/parse.js");
    const { store } = await import("../src/store.js");
    store.loadSample(); // lahacks-f26 active
    const other = "other-event-" + process.pid;
    store.events.set(other, { id: other, name: "Other", date: "2026-10-18", sources: [], loadStatus: "ready" });
    store.upsertPerson(other, "sentry", "Steve Jobs", { role: "co-founder", facts: [], match: "high", matchReason: "list", fromEventList: true });
    assert.equal(findListedPersonByName("Steve Jobes")?.name, "Steve Jobs");
    assert.equal(findListedPersonByName("Steeve Jobs")?.name, "Steve Jobs");
    assert.equal(findListedPersonByName("Someone Else"), null);
  });
});
