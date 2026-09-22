import { test } from "node:test";
import assert from "node:assert/strict";
import { esc } from "../../app/ui/html.js";

test("esc escapa los cinco caracteres peligrosos", () => {
  assert.equal(esc(`<b a="x">&'`), "&lt;b a=&quot;x&quot;&gt;&amp;&#39;");
});

test("esc tolera null, undefined y números", () => {
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(12.5), "12.5");
});
