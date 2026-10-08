# dynamical-grib

A GRIB2 decoder for dynamical.org's virtual Icechunk stores, built from
[gribberish](https://github.com/mpiannucci/gribberish) with `wasm-bindgen`.
Each virtual chunk is a complete GRIB2 message in a NOAA or ECMWF file.
The decoder runs on one thread without SharedArrayBuffer or COOP/COEP headers.

- `crate/` is the Rust wrapper, ported from dynamical.org's explorer. It
  mirrors the Python codec's longitude roll and north-up grid adjustment.
- `gribwasm.js`, `gribwasm.d.ts`, `gribwasm_bg.wasm` and
  `gribwasm_bg.wasm.d.ts` are generated `wasm-bindgen --target web` output.
  Do not edit them by hand. `SHA256SUMS` covers all four files.
- `codec.ts` registers the read-only `gribberish` zarrita codec. Await
  `registerGribberishCodec()` before opening arrays. Registration imports
  zarrita lazily; the first decode loads the wasm through Vite's `?url` asset.
- `retry-fetch.ts` supplies an Icechunk fetch client for virtual byte ranges,
  retrying network errors, HTTP 429 and HTTP 5xx with abort-aware backoff.
- `LICENSE-gribberish` and `THIRD_PARTY_LICENSES` contain redistribution
  notices for the wasm's runtime dependencies. Vite builds emit them at
  `licenses/dynamical-grib.txt` in the build output (`dist/` for web, Tauri,
  and lite; `dist-embed/` for embed, copied into the Python wheel's
  `geolibre/static/app/`). Keep these notices with any distributed decoder bundle.

To rebuild (Rust **1.97.0**, `wasm32-unknown-unknown`, and
**wasm-bindgen-cli 0.2.129** are required):

```bash
cargo install wasm-bindgen-cli --version 0.2.129 --locked
packages/plugins/src/plugins/dynamical-grib/crate/build.sh
```

`crate/rust-toolchain.toml` pins Rust; `crate/Cargo.lock` pins the dependency
graph. Gribberish **1.8.0** is pinned to commit
`746e986ed5ac46c58d5137e458dc8ba715abd5d7`, with default features disabled
and only `png` enabled. The package is named `geolibre-dynamical-grib`; its
library name remains `gribwasm` to preserve the generated exports.

The script keeps build products outside the repository (default
`/tmp/dynamical-gribwasm-target`) and remaps Cargo/crate paths so builds are
reproducible. Set `CARGO_TARGET_DIR` for a fresh comparison build,
`CARGO_NET_OFFLINE=true` to use cached dependencies, and `WASM_BINDGEN` if the
CLI is outside PATH. It regenerates `SHA256SUMS`, including the declarations.
Two fresh builds matched each other and the explorer's wasm SHA-256:
`989bfd6893cb231b48d74f846f88c9fc281d33393657d8b60e3c97905c03a464`.

`tests/dynamical-grib.test.ts` checks the generated checksums, compares every
fixture value bit-for-bit against gribberish's Python codec, reads v3 arrays
through zarrita (including `scale_offset`), and tests the retry client.
Fixture provenance and regeneration steps are in
`tests/fixtures/dynamical-grib/README.md`.

| GRIB2 data representation template | Coverage |
| --- | --- |
| 5.0 simple packing | Built; fixtures include a bitmap field |
| 5.2 / 5.3 complex packing / spatial differencing | Built; fixtures cover 5.3, including bitmap fields, but not 5.2 |
| 5.41 PNG | Built with the pure Rust `png` crate; no fixture |
| 5.42 CCSDS / AEC | Built with gribberish's pure Rust decoder (`libaec` is disabled); ECMWF AIFS fixture |
| 5.40 JPEG 2000 | Not built; requires OpenJPEG (C) |

The runtime dependencies' exact names, versions and license expressions are
in `THIRD_PARTY_LICENSES`, together with their source license texts and an
explicit list of excluded build-only dependencies. Copyright and permission
comments from the runtime sources are retained too, including inherited math
notices in `libm` and `const_soft_float`. Most are MIT or
MIT/Apache-2.0; `mappers` is Apache-2.0, `zlib-rs` is Zlib,
`miniz_oxide` also offers Zlib, `memchr` offers Unlicense/MIT, and
`unicode-ident` additionally requires Unicode-3.0. Unicode-ident is retained
because it is reachable through wasm-bindgen-shared's normal dependencies,
even though proc macros also use it.
