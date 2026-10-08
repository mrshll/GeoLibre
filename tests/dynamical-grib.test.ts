import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as zarr from "zarrita";
import {
  GribberishCodec,
  drsTemplate,
  initGrib,
  registerGribberishCodec,
  type GribberishConfig,
} from "../packages/plugins/src/plugins/dynamical-grib/codec";
import {
  retryingFetchClient,
  type RetryInfo,
} from "../packages/plugins/src/plugins/dynamical-grib/retry-fetch";

interface Fixture {
  drs: number;
  bitmap: boolean;
  shape: [number, number];
  fileSha256: string;
  cases: {
    config: GribberishConfig;
    sha256: string;
    nanCount: number;
    samples: { row: number; col: number; value: number | null }[];
  }[];
}

const grib = new URL("../packages/plugins/src/plugins/dynamical-grib/", import.meta.url);
const fixtures = new URL("fixtures/dynamical-grib/", import.meta.url);
const expected: Record<string, Fixture> = JSON.parse(
  readFileSync(new URL("expected.json", fixtures), "utf8"),
).fixtures;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fixtureBytes = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(name, fixtures)));

describe("dynamical GRIB decoder", () => {
  it("registers lazily, retries failed initialisation and shares the first successful promise", async () => {
    const registry: typeof zarr.registry = new Map();
    await registerGribberishCodec(registry);
    const factory = registry.get("gribberish");
    assert.ok(factory);
    await registerGribberishCodec(registry);
    assert.equal(registry.get("gribberish"), factory);
    assert.equal(await factory(), GribberishCodec);
    assert.throws(() => drsTemplate(fixtureBytes("simple.grib2")), /call initGrib/);
    await assert.rejects(initGrib(new Uint8Array(16)), WebAssembly.CompileError);
    const ready = initGrib(readFileSync(new URL("gribwasm_bg.wasm", grib)));
    assert.equal(initGrib(new Uint8Array(16)), ready);
    await ready;
  });

  it("checks all generated files against SHA256SUMS", () => {
    const sums = readFileSync(new URL("SHA256SUMS", grib), "utf8").trim().split("\n");
    const names = [];
    for (const line of sums) {
      const [sum, name] = line.split(/\s+/);
      names.push(name);
      assert.equal(sha256(readFileSync(new URL(name, grib))), sum, name);
    }
    assert.deepEqual(names.sort(), [
      "gribwasm.d.ts",
      "gribwasm.js",
      "gribwasm_bg.wasm",
      "gribwasm_bg.wasm.d.ts",
    ]);
  });

  for (const [name, fx] of Object.entries(expected)) {
    it(`${name}: DRS 5.${fx.drs}${fx.bitmap ? " + bitmap" : ""} matches the Python codec`, async () => {
      const bytes = fixtureBytes(name);
      assert.equal(sha256(bytes), fx.fileSha256, "fixture changed; regenerate expected.json");
      assert.equal(drsTemplate(bytes), fx.drs);
      for (const c of fx.cases) {
        const label = JSON.stringify(c.config);
        const chunk = await GribberishCodec.fromConfig(
          { var: "fixture", ...c.config },
          { dataType: "float64", shape: fx.shape },
        ).decode(bytes);
        assert.ok(chunk.data instanceof Float64Array);
        assert.deepEqual(chunk.shape, fx.shape);
        assert.deepEqual(chunk.stride, [fx.shape[1], 1]);
        // Hash every value, including NaN positions, for a bit-exact comparison.
        assert.equal(
          sha256(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)),
          c.sha256,
          label,
        );
        assert.equal(chunk.data.filter(Number.isNaN).length, c.nanCount, label);
        for (const s of c.samples) {
          const value: number = chunk.data[s.row * fx.shape[1] + s.col];
          if (s.value === null) assert.ok(Number.isNaN(value), `${label} [${s.row},${s.col}]`);
          else assert.equal(value, s.value, `${label} [${s.row},${s.col}]`);
        }
      }
    });
  }

  it("casts float32 arrays to Float32Array", async () => {
    const bytes = fixtureBytes("complex-spatial.grib2");
    const config = { adjust_longitude_range: true, north_up: true };
    const f64 = await GribberishCodec.fromConfig(config, {
      dataType: "float64",
      shape: [46, 90],
    }).decode(bytes);
    const f32 = await GribberishCodec.fromConfig(config, {
      dataType: "float32",
      shape: [46, 90],
    }).decode(bytes);
    assert.ok(f32.data instanceof Float32Array);
    assert.deepEqual(f32.data, Float32Array.from(f64.data));
  });

  it("preserves leading and trailing singleton chunk dimensions", async () => {
    const chunk = await GribberishCodec.fromConfig(undefined, {
      dataType: "float64",
      shape: [1, 1, 46, 90, 1],
    }).decode(fixtureBytes("simple.grib2"));
    assert.deepEqual(chunk.shape, [1, 1, 46, 90, 1]);
    assert.deepEqual(chunk.stride, [4140, 4140, 90, 1, 1]);
  });

  it("rejects mismatched shapes, other dtypes, coordinate decoding, encoding and invalid GRIB", async () => {
    await assert.rejects(
      GribberishCodec.fromConfig({}, { dataType: "float64", shape: [45, 90] }).decode(
        fixtureBytes("simple.grib2"),
      ),
      /message has 4140 points, chunk shape \[45,90\] needs 4050/,
    );
    assert.throws(
      () => GribberishCodec.fromConfig({}, { dataType: "int16", shape: [46, 90] }),
      /unsupported data type int16/,
    );
    for (const name of ["latitude", "longitude"]) {
      assert.throws(
        () => GribberishCodec.fromConfig({ var: name }, { dataType: "float64", shape: [46, 90] }),
        /not supported/,
      );
    }
    assert.throws(
      () => GribberishCodec.fromConfig({}, { dataType: "float64", shape: [46, 90] }).encode(),
      /read-only/,
    );
    await assert.rejects(
      GribberishCodec.fromConfig({}, { dataType: "float64", shape: [1] }).decode(
        new Uint8Array(16),
      ),
      /GRIB/,
    );
  });

  it("reads v3 arrays through zarrita's registry and optional scale_offset pipeline", async () => {
    await registerGribberishCodec();
    const factory = zarr.registry.get("gribberish");
    await registerGribberishCodec();
    assert.equal(zarr.registry.get("gribberish"), factory);
    assert.ok(factory);
    assert.equal(await factory(), GribberishCodec);
    // NOAA GFS virtual temperature_2m/zarr.json uses offset=-273.15 followed
    // by gribberish(var=TMP, adjust_longitude_range=true, north_up=true).
    const scaleOffsets: ({ scale?: number; offset: number } | undefined)[] = [
      undefined,
      { offset: -273.15 },
      { scale: 2, offset: 273.15 },
    ];
    for (const [name, fx] of Object.entries(expected)) {
      for (const configCase of fx.cases) {
        for (const dtype of ["float64", "float32"] as const) {
          for (const scaleOffset of scaleOffsets) {
            const shape = [1, 1, ...fx.shape, 1];
            const codecs = [
              ...(scaleOffset ? [{ name: "scale_offset", configuration: scaleOffset }] : []),
              { name: "gribberish", configuration: { var: "TMP", ...configCase.config } },
            ];
            const store = new Map([
              [
                "/zarr.json",
                new TextEncoder().encode(
                  JSON.stringify({
                    zarr_format: 3,
                    node_type: "array",
                    shape,
                    data_type: dtype,
                    chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },
                    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
                    fill_value: "NaN",
                    codecs,
                    attributes: {},
                  }),
                ),
              ],
              ["/c/0/0/0/0/0", fixtureBytes(name)],
            ]);
            const array = await zarr.open(store, { kind: "array" });
            const chunk = await zarr.get(array);
            const raw = await GribberishCodec.fromConfig(configCase.config, {
              dataType: dtype,
              shape,
            }).decode(fixtureBytes(name));
            const ctr = dtype === "float64" ? Float64Array : Float32Array;
            const values = scaleOffset
              ? raw.data.map(
                  (value: number) => value / (scaleOffset.scale ?? 1) + scaleOffset.offset,
                )
              : raw.data;
            assert.ok(chunk.data instanceof ctr);
            assert.deepEqual(chunk.shape, shape);
            assert.deepEqual(chunk.stride, [4140, 4140, 90, 1, 1]);
            assert.deepEqual(chunk.data, values, `${name} ${dtype} ${JSON.stringify(scaleOffset)}`);
          }
        }
      }
    }
  });
});

const noSleep = async (): Promise<void> => {};
const response = (status: number): Response =>
  new Response(status === 206 ? "ok" : null, { status });

describe("retryingFetchClient", () => {
  it("retries 503 and network errors, preserving URL and range headers", async () => {
    const replies = [response(503), new TypeError("Failed to fetch"), response(206)];
    const seen: [string, string | null][] = [];
    const retries: RetryInfo[] = [];
    const client = retryingFetchClient({
      sleep: noSleep,
      onRetry: (info) => retries.push(info),
      fetchImpl: async (url, init) => {
        seen.push([url, new Headers(init?.headers).get("Range")]);
        const reply = replies.shift();
        assert.ok(reply);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    assert.equal(
      (await client.fetch("https://x/f.grib2", { headers: { Range: "bytes=0-9" } })).status,
      206,
    );
    assert.deepEqual(client.stats, { attempts: 3, retries: 2 });
    assert.deepEqual(seen, Array(3).fill(["https://x/f.grib2", "bytes=0-9"]));
    assert.deepEqual(retries, [
      { url: "https://x/f.grib2", attempt: 1, reason: "HTTP 503" },
      { url: "https://x/f.grib2", attempt: 2, reason: "Failed to fetch" },
    ]);
  });

  it("does not retry 4xx other than 429", async () => {
    const client = retryingFetchClient({ sleep: noSleep, fetchImpl: async () => response(404) });
    assert.equal((await client.fetch("u")).status, 404);
    assert.deepEqual(client.stats, { attempts: 1, retries: 0 });
  });

  it("returns the last response or throws the last error after maxAttempts", async () => {
    const reasons: string[] = [];
    const client = retryingFetchClient({
      maxAttempts: 3,
      sleep: noSleep,
      fetchImpl: async () => response(429),
      onRetry: (info) => reasons.push(info.reason),
    });
    assert.equal((await client.fetch("u")).status, 429);
    assert.deepEqual(client.stats, { attempts: 3, retries: 2 });
    assert.deepEqual(reasons, ["HTTP 429", "HTTP 429"]);
    const errorClient = retryingFetchClient({
      maxAttempts: 2,
      sleep: noSleep,
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await assert.rejects(errorClient.fetch("u"), /Failed to fetch/);
    assert.deepEqual(errorClient.stats, { attempts: 2, retries: 1 });
  });

  it("does not retry an aborted request", async () => {
    const ac = new AbortController();
    const client = retryingFetchClient({
      sleep: noSleep,
      fetchImpl: async () => {
        ac.abort();
        throw new DOMException("aborted", "AbortError");
      },
    });
    await assert.rejects(client.fetch("u", { signal: ac.signal }), /aborted/);
    assert.deepEqual(client.stats, { attempts: 1, retries: 0 });
  });

  it("doubles backoff with 0.5–1.5 jitter", async () => {
    const waits: number[] = [];
    const replies = [response(503), response(503), response(503), response(206)];
    const client = retryingFetchClient({
      baseMs: 100,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: async () => {
        const reply = replies.shift();
        assert.ok(reply);
        return reply;
      },
    });
    await client.fetch("u");
    assert.equal(waits.length, 3);
    waits.forEach((ms, i) => assert.ok(ms >= 50 * 2 ** i && ms <= 150 * 2 ** i));
  });

  it("cancels retry response bodies and keeps stats across requests", async () => {
    let cancelled = 0;
    const client = retryingFetchClient({
      maxAttempts: 2,
      sleep: noSleep,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }),
          { status: 503 },
        ),
    });
    const first = await client.fetch("u");
    assert.equal(cancelled, 1);
    assert.equal(first.body?.locked, false);
    await first.body?.cancel();
    const second = await client.fetch("v");
    assert.deepEqual(client.stats, { attempts: 4, retries: 2 });
    assert.equal(cancelled, 3);
    await second.body?.cancel();
  });

  it("stops promptly when aborted during the default backoff", async () => {
    const ac = new AbortController();
    const client = retryingFetchClient({
      baseMs: 60_000,
      fetchImpl: async () => response(503),
      onRetry: () => setImmediate(() => ac.abort()),
    });
    await assert.rejects(client.fetch("u", { signal: ac.signal }), { name: "AbortError" });
    assert.equal(client.stats.attempts, 1);
  });

  it("handles abort before fetching and between a response and sleeping", async () => {
    const ac = new AbortController();
    ac.abort();
    const client = retryingFetchClient({ fetchImpl: async () => response(503) });
    await assert.rejects(client.fetch("u", { signal: ac.signal }), { name: "AbortError" });
    assert.equal(client.stats.attempts, 0);
    const duringRetry = new AbortController();
    const retryClient = retryingFetchClient({
      baseMs: 60_000,
      fetchImpl: async () => response(503),
      onRetry: () => duringRetry.abort(new Error("cancelled before sleep")),
    });
    await assert.rejects(
      retryClient.fetch("u", { signal: duringRetry.signal }),
      /cancelled before sleep/,
    );
    assert.equal(retryClient.stats.attempts, 1);
  });

  it("checks the signal after an injected sleep resolves", async () => {
    const ac = new AbortController();
    const client = retryingFetchClient({
      fetchImpl: async () => response(503),
      sleep: async () => {
        ac.abort();
      },
    });
    await assert.rejects(client.fetch("u", { signal: ac.signal }), { name: "AbortError" });
    assert.equal(client.stats.attempts, 1);
  });
});
