import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("app/version.json tiene un campo version no vacío", async () => {
  const raw = await readFile(new URL("../../app/version.json", import.meta.url), "utf8");
  const v = JSON.parse(raw);
  assert.equal(typeof v.version, "string");
  assert.ok(v.version.length >= 6, "version demasiado corta");
});
