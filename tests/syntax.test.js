import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("every runtime JavaScript file passes Node syntax checking", () => {
  for (const filename of readdirSync(resolve(root, "scripts"))) {
    if (!filename.endsWith(".js")) continue;
    execFileSync(process.execPath, [
      "--check",
      resolve(root, "scripts", filename)
    ]);
  }
});
