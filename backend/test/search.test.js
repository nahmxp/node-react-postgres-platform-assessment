import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SEARCH_URL = "http://search.test:9200";
const { searchHealth } = await import("../src/search.js");

test("searchHealth calls /_cluster/health on SEARCH_URL", async () => {
  let calledUrl;
  globalThis.fetch = async (url) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ status: "green" }) };
  };
  const health = await searchHealth();
  assert.equal(calledUrl, "http://search.test:9200/_cluster/health");
  assert.equal(health.status, "green");
});

test("searchHealth throws on non-2xx", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(searchHealth(), /503/);
});
