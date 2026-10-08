import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { copyDynamicalGribLicenses } from "../apps/geolibre-desktop/vite-plugins/copy-dynamical-grib-licenses";

const sourceDir = new URL("../packages/plugins/src/plugins/dynamical-grib/", import.meta.url);
const thirdParty = readFileSync(new URL("THIRD_PARTY_LICENSES", sourceDir), "utf8");
const gribberish = readFileSync(new URL("LICENSE-gribberish", sourceDir), "utf8");

interface EmittedAsset {
  type: string;
  fileName?: string;
  source?: string | Uint8Array;
}

function emitNotices(plugin: Plugin): EmittedAsset[] {
  const hook = plugin.generateBundle;
  assert.ok(typeof hook === "function");
  const assets: EmittedAsset[] = [];
  Reflect.apply(
    hook,
    {
      emitFile(asset: EmittedAsset): string {
        assets.push(asset);
        return "license-asset";
      },
    },
    [],
  );
  return assets;
}

test("build-only plugin emits source notices at a stable path without duplicating gribberish", () => {
  const plugin = copyDynamicalGribLicenses(fileURLToPath(sourceDir));
  assert.equal(plugin.apply, "build");
  const fullNotice = gribberish.slice(gribberish.indexOf("Copyright ")).trim();
  assert.ok(
    thirdParty.includes(fullNotice),
    "source notices contain the full gribberish MIT notice",
  );
  assert.deepEqual(emitNotices(plugin), [
    {
      type: "asset",
      fileName: "licenses/dynamical-grib.txt",
      source: thirdParty,
    },
  ]);
});

test("appends gribberish when only part of its notice is present", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dynamical-grib-licenses-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const partial = "Other dependency notices\nCopyright 2022 Matthew Iannucci\n";
  writeFileSync(join(dir, "THIRD_PARTY_LICENSES"), partial);
  writeFileSync(join(dir, "LICENSE-gribberish"), gribberish);
  assert.deepEqual(emitNotices(copyDynamicalGribLicenses(dir)), [
    {
      type: "asset",
      fileName: "licenses/dynamical-grib.txt",
      source: `${partial.trimEnd()}\n\n${gribberish}`,
    },
  ]);
});

test("reads source notices at build time", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dynamical-grib-licenses-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "LICENSE-gribberish"), gribberish);
  writeFileSync(join(dir, "THIRD_PARTY_LICENSES"), thirdParty);
  const plugin = copyDynamicalGribLicenses(dir);
  const updated = `${thirdParty}\nNew dependency notice\n`;
  writeFileSync(join(dir, "THIRD_PARTY_LICENSES"), updated);
  assert.equal(emitNotices(plugin)[0].source, updated);
});
