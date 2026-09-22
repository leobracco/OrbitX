import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("app/version.json tiene un campo version no vacío", async () => {
  const raw = await readFile(new URL("../../app/version.json", import.meta.url), "utf8");
  const v = JSON.parse(raw);
  assert.equal(typeof v.version, "string");
  assert.ok(v.version.length >= 6, "version demasiado corta");
});

test("la VERSION literal de sw.js coincide con app/version.json", async () => {
  const sw = await readFile(new URL("../../app/sw.js", import.meta.url), "utf8");
  const m = sw.match(/const VERSION\s*=\s*"([^"]+)"/);
  assert.ok(m, "sw.js debe declarar const VERSION = \"...\"");
  const v = JSON.parse(await readFile(new URL("../../app/version.json", import.meta.url), "utf8"));
  assert.equal(m[1], v.version);
});
