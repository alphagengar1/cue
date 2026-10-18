import "./_env.js";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Card, Fact } from "../../shared/types.js";
import {
  cleanSource, enforceCards, factAboutPerson, filterFacts, isLinkedIn, isSensitive, LIMITS, sanitize, wrapBody,
} from "../src/safety.js";
import { assertValidCard } from "./_helpers.js";

const card = (p: Partial<Card>): Card => ({ kind: "context", title: "Context", body: "Builds edge networks.", source: "cloudflare.com", ...p });
const one = (p: Partial<Card>): Card | undefined => enforceCards([card(p)])[0];

describe("enforceCards: titles", () => {
  test("short title kept", () => { assert.equal(one({ title: "Edge panel" })?.title, "Edge panel"); });
  test("long title cut at a word boundary, no ellipsis", () => {
    const t = one({ title: "Ask about her recent talk" })!.title;
    assert.equal(t, "Ask about her recent");
    assert.ok(t.length <= LIMITS.title);
  });
  test("trailing punctuation removed after cut", () => {
    const t = one({ title: "Recent talk, plus a long tail" })!.title;
    assert.ok(t.length <= 20 && !/[,\s]$/.test(t), t);
  });
  test("empty / whitespace title falls back per kind", () => {
    assert.equal(one({ kind: "connect", title: "  " })?.title, "Connect");
    assert.equal(one({ kind: "context", title: "" })?.title, "Context");
    assert.equal(one({ kind: "angle", title: "", source: null })?.title, "Your angle");
  });
  test("cut that leaves a stub (< 8 chars) falls back", () => {
    assert.equal(one({ kind: "context", title: "Edge computingplatformsandmore" })?.title, "Context");
  });
  test("single word longer than 20 chars stays within 20", () => {
    const t = one({ title: "Supercalifragilisticexpialidocious" })!.title;
    assert.ok(t.length <= 20, `${t} (${t.length})`);
  });
});

describe("enforceCards: bodies", () => {
  test("long body wrapped to <= 5 lines x 40, <= 200 chars", () => {
    const c = one({ body: "Cloudflare runs one of the largest networks on the planet and ships Workers, R2, D1, Durable Objects and AI inference at the edge for developers everywhere, every single day of the week." })!;
    assertValidCard(c);
    assert.ok(c.body.includes("\n"));
  });
  test("overflow ends with an ellipsis and stays in limits", () => {
    const b = wrapBody("word ".repeat(80));
    assert.ok(b.length <= 200 && b.split("\n").length <= 5);
    assert.ok(b.endsWith("..."));
  });
  test("very long token (URL) is hard-split", () => {
    const b = wrapBody("see https://example.com/" + "a".repeat(100));
    for (const l of b.split("\n")) assert.ok(l.length <= 40);
  });
  test("empty body after sanitize -> card dropped", () => {
    assert.equal(one({ body: "🚀🚀" }), undefined);
  });
});

describe("enforceCards: sources", () => {
  test("connect/context without a source are dropped", () => {
    assert.equal(one({ kind: "connect", source: null }), undefined);
    assert.equal(one({ kind: "context", source: "" }), undefined);
    assert.equal(one({ kind: "context", source: "https://" }), undefined);
  });
  test("angle without source is kept", () => {
    assert.ok(one({ kind: "angle", title: "Your angle", source: null }));
  });
  test("source cleaned: no scheme, www, src:, query, trailing slash; <= 34", () => {
    assert.equal(cleanSource("src: https://www.anduril.com/blog/?utm=x#top"), "anduril.com/blog");
    const long = cleanSource("https://blog.cloudflare.com/2026/10/some-really-long-post-slug-here/")!;
    assert.ok(long.length <= 34 && long.startsWith("blog.cloudflare.com"), long);
    assert.equal(cleanSource(null), null);
  });
  test("card citing LinkedIn is dropped", () => {
    assert.equal(one({ kind: "connect", source: "https://www.linkedin.com/in/someone" }), undefined);
  });
});

describe("enforceCards: allowedHosts (model-cited sources must come from input facts)", () => {
  const opts = { allowedHosts: ["cloudflare.com", "youtube.com"] };
  test("allowed host and subdomain kept", () => {
    assert.ok(enforceCards([card({ source: "blog.cloudflare.com/x" })], opts)[0]);
    assert.ok(enforceCards([card({ kind: "connect", source: "youtube.com/watch" })], opts)[0]);
  });
  test("invented host dropped for connect/context, nulled for angle", () => {
    assert.equal(enforceCards([card({ kind: "connect", source: "made-up.dev/talk" })], opts).length, 0);
    assert.equal(enforceCards([card({ kind: "angle", source: "made-up.dev" })], opts)[0]?.source, null);
  });
  test("without allowedHosts behaviour is unchanged", () => {
    assert.ok(one({ source: "made-up.dev/talk" }));
  });
});

describe("filterFacts / LinkedIn / sensitive topics", () => {
  const fact = (text: string, sourceUrl: string): Fact => ({ text, sourceUrl, sourceKind: "article" });
  test("isLinkedIn: host and subdomains, not lookalikes", () => {
    assert.ok(isLinkedIn("https://www.linkedin.com/in/a"));
    assert.ok(isLinkedIn("https://uk.linkedin.com/in/a"));
    assert.ok(!isLinkedIn("https://notlinkedin.com/a"));
    assert.ok(!isLinkedIn("not a url"));
  });
  test("filterFacts drops LinkedIn and sensitive facts, keeps the rest", () => {
    const kept = filterFacts([
      fact("Spoke at KubeCon about eBPF.", "https://youtube.com/watch?v=1"),
      fact("Recruiter at Anduril.", "https://www.linkedin.com/in/x"),
      fact("Married with two kids.", "https://example.com/about"),
    ]);
    assert.deepEqual(kept.map((f) => f.text), ["Spoke at KubeCon about eBPF."]);
  });
  test("isSensitive: whole words and stems, case-insensitive", () => {
    for (const s of ["her Husband works", "PREGNANT", "religious views", "Democrats", "lives in Pasadena", "is 34 years old"]) {
      assert.ok(isSensitive(s), s);
    }
    for (const s of ["Jackson Hole", "personal site", "Kidsfirst Publishing", "politician"]) {
      assert.ok(!isSensitive(s), s);
    }
  });
  test("multi-word terms still caught when the body wraps across lines", () => {
    const body = "Ask about the robotics team she leads and how the move went; she lives in Pasadena now.";
    assert.ok(wrapBody(body).includes("lives\nin") || wrapBody(body).includes("lives in"));
    assert.equal(one({ body }), undefined);
    assert.ok(isSensitive("born\nin 1990"));
  });
  test("institution names are not personal topics; the personal sense still is", () => {
    for (const s of ["Studied at Temple University", "Built tools for Children's Hospital LA", "MS in Political Science", "Cancer Center data team"]) {
      assert.ok(!isSensitive(s), s);
    }
    for (const s of ["her son plays soccer", "Visits the temple weekly", "Has two children", "Children love it"]) {
      assert.ok(isSensitive(s), s);
    }
  });
  test("cards mentioning sensitive topics are dropped", () => {
    assert.equal(one({ body: "Ask about her husband and kids." }), undefined);
    assert.equal(one({ kind: "angle", source: null, body: "Talk politics with them." }), undefined);
  });
  test("sensitive word in the title is dropped too", () => {
    assert.equal(one({ title: "Her kids", body: "Works on edge networking." }), undefined);
  });
});

describe("sanitize", () => {
  test("smart punctuation mapped to ASCII", () => {
    assert.equal(sanitize("“Hi” it’s – ok…"), "\"Hi\" it's - ok...");
  });
  test("accents stripped, emoji/CJK dropped, safe glyphs kept", () => {
    assert.equal(sanitize("José 🚀 東京 ━●"), "Jose   ━●");
  });
  test("newlines kept", () => { assert.equal(sanitize("a\nb"), "a\nb"); });
  test("tab separates words", () => {
    assert.equal(wrapBody("Edge\tcompute"), "Edge compute");
  });
});

describe("factAboutPerson (research re-check)", () => {
  const f = (text: string, sourceUrl = "https://example.com/a") => ({ text, sourceUrl, sourceKind: "article" as const });
  const ok = (text: string, url?: string) => factAboutPerson(f(text, url), "Priya Shah", ["Anduril", "Anduril Industries"], ["anduril.com"]);
  test("needs the name (full or first + last) AND the org", () => {
    assert.ok(ok("Priya Shah spoke about hiring at Anduril."));
    assert.ok(ok("Priya, a recruiter, ran Anduril's info session with Shah's team."));
    assert.ok(!ok("Shah spoke about hiring at Anduril."), "last name only");
    assert.ok(!ok("Anduril opened a new office."), "org only");
    assert.ok(!ok("Priya Shah spoke at ROSCon."), "name only");
  });
  test("org can come from the URL or the org's domain", () => {
    assert.ok(ok("Priya Shah hosted an intern panel.", "https://www.anduril.com/careers/panel"));
    assert.ok(ok("Priya Shah hosted an intern panel.", "https://blog.anduril.com/x"));
  });
});

describe("LinkedIn as a source (ALLOW_LINKEDIN)", () => {
  test("blocked in tests by default; allowed when the flag is on", async () => {
    const { config } = await import("../src/config.js");
    const facts: Fact[] = [{ text: "Priya Shah leads university recruiting at Anduril.", sourceUrl: "https://www.linkedin.com/in/priyashah", sourceKind: "article" }];
    assert.equal(filterFacts(facts).length, 0);
    const was = config.allowLinkedIn;
    (config as { allowLinkedIn: boolean }).allowLinkedIn = true;
    try {
      assert.equal(filterFacts(facts).length, 1);
      assert.equal(enforceCards([{ kind: "context", title: "Who they are", body: "Leads university recruiting.", source: "linkedin.com/in/priyashah" }]).length, 1);
    } finally { (config as { allowLinkedIn: boolean }).allowLinkedIn = was; }
  });
});
