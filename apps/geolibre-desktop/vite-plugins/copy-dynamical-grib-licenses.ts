import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

// The Dynamical plugin's GRIB2 decoder (packages/plugins/src/plugins/dynamical-grib/) compiles
// gribberish and its dependencies into a wasm that every build ships. Their MIT and Apache-2.0
// terms ask for the notices to travel with copies, and the minifier drops legal comments, so the
// notices are emitted as a text file at a stable path beside the bundle:
// `licenses/dynamical-grib.txt`. Read from the decoder's own notice files, the single source.
export function copyDynamicalGribLicenses(sourceDir: string): Plugin {
  return {
    name: "geolibre:copy-dynamical-grib-licenses",
    apply: "build",
    generateBundle() {
      const thirdParty = readFileSync(join(sourceDir, "THIRD_PARTY_LICENSES"), "utf8");
      const gribberish = readFileSync(join(sourceDir, "LICENSE-gribberish"), "utf8");
      // LICENSE-gribberish starts with provenance; compare the full notice itself.
      const noticeStart = gribberish.indexOf("Copyright ");
      if (noticeStart === -1) {
        throw new Error("copy-dynamical-grib-licenses: missing gribberish copyright notice");
      }
      const notice = gribberish.slice(noticeStart).trim();
      this.emitFile({
        type: "asset",
        fileName: "licenses/dynamical-grib.txt",
        source: thirdParty.includes(notice)
          ? thirdParty
          : `${thirdParty.trimEnd()}\n\n${gribberish}`,
      });
    },
  };
}
