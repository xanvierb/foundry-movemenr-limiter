import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("module manifest declares v13-v14 compatibility and existing entry files", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "module.json"), "utf8")
  );
  assert.equal(manifest.id, "movement-rate-limiter");
  assert.equal(manifest.compatibility.minimum, "13");
  assert.match(manifest.compatibility.verified, /^14/);
  assert.equal(manifest.socket, true);
  assert.equal(
    manifest.manifest,
    "https://raw.githubusercontent.com/xanvierb/foundry-movemenr-limiter/refs/heads/main/module.json"
  );

  for (const relativePath of [
    ...manifest.esmodules,
    ...manifest.styles,
    ...manifest.languages.map((language) => language.path)
  ]) {
    const content = await readFile(path.join(root, relativePath));
    assert.ok(content.length > 0, `${relativePath} should not be empty`);
  }
});

test("English and Dutch localization files contain identical keys", async () => {
  const english = JSON.parse(
    await readFile(path.join(root, "lang/en.json"), "utf8")
  );
  const dutch = JSON.parse(
    await readFile(path.join(root, "lang/nl.json"), "utf8")
  );
  assert.deepEqual(Object.keys(dutch).sort(), Object.keys(english).sort());
});
