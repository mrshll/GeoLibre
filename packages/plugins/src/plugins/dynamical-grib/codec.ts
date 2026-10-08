// Each virtual Icechunk chunk is one GRIB2 message. This mirrors gribberish's
// Python codec: decode, adjust grid orientation, cast dtype, then reshape.
import type { Chunk } from "zarrita";
import type { InitInput } from "./gribwasm.js";

export interface GribberishConfig {
  var?: string;
  adjust_longitude_range?: boolean;
  north_up?: boolean;
}

interface ChunkMeta {
  dataType: string;
  shape: number[];
}

type CodecRegistry = typeof import("zarrita").registry;
type RegistryEntry = Awaited<ReturnType<NonNullable<ReturnType<CodecRegistry["get"]>>>>;
type GribChunk = Chunk<"float32" | "float64">;

let ready: Promise<void> | null = null;
let glue: typeof import("./gribwasm.js") | null = null;

/** Running totals for decoder diagnostics. */
export const gribStats = { decodes: 0, decodeMs: 0, initMs: 0 };

/**
 * Initialise the decoder once, allowing a later call to retry after failure.
 *
 * @param source Wasm bytes/module or URL. Omitted, load Vite's emitted asset URL.
 * @returns The shared initialisation promise.
 */
export function initGrib(source?: InitInput): Promise<void> {
  if (!ready) {
    const t0 = performance.now();
    ready = import("./gribwasm.js")
      .then(async (m) => {
        const wasmSource = source ?? (await import("./gribwasm_bg.wasm?url")).default;
        await m.default({ module_or_path: wasmSource });
        glue = m;
        gribStats.initMs = performance.now() - t0;
      })
      .catch((error: unknown) => {
        ready = null;
        throw error;
      });
  }
  return ready;
}

function cStrides(shape: number[]): number[] {
  const out = new Array<number>(shape.length);
  for (let i = shape.length - 1, acc = 1; i >= 0; i--) {
    out[i] = acc;
    acc *= shape[i];
  }
  return out;
}

/**
 * Read the GRIB2 section 5 template number after initGrib() has resolved.
 *
 * @param bytes One GRIB2 message.
 * @returns The data representation template number (e.g. 3 or 42).
 */
export function drsTemplate(bytes: Uint8Array): number {
  if (!glue) throw new Error("gribberish codec: call initGrib() first");
  return glue.drs_template(bytes);
}

export class GribberishCodec {
  readonly kind = "array_to_bytes";
  private readonly adjustLongitudeRange: boolean;
  private readonly northUp: boolean;
  private readonly meta: ChunkMeta;

  constructor(config: GribberishConfig, meta: ChunkMeta) {
    if (meta.dataType !== "float64" && meta.dataType !== "float32") {
      throw new Error(`gribberish codec: unsupported data type ${meta.dataType}`);
    }
    if (config.var === "latitude" || config.var === "longitude") {
      throw new Error(`gribberish codec: var=${config.var} (coordinate decoding) is not supported`);
    }
    this.adjustLongitudeRange = Boolean(config.adjust_longitude_range);
    this.northUp = Boolean(config.north_up);
    this.meta = meta;
  }

  /** zarrita's codec factory hook. */
  static fromConfig(config: GribberishConfig | undefined, meta: ChunkMeta): GribberishCodec {
    return new GribberishCodec(config ?? {}, meta);
  }

  /**
   * Decode and reshape a virtual chunk, including leading singleton dimensions.
   *
   * @param bytes One GRIB2 message.
   * @returns Row-major float data with the declared chunk shape and strides.
   */
  async decode(bytes: Uint8Array): Promise<GribChunk> {
    await initGrib();
    if (!glue) throw new Error("gribberish codec: decoder is not initialised");
    const t0 = performance.now();
    const values = glue.decode(bytes, this.adjustLongitudeRange, this.northUp);
    gribStats.decodes++;
    gribStats.decodeMs += performance.now() - t0;
    const shape = this.meta.shape;
    const n = shape.reduce((a, b) => a * b, 1);
    if (values.length !== n) {
      throw new Error(
        `gribberish codec: message has ${values.length} points, chunk shape [${shape}] needs ${n}`,
      );
    }
    const data = this.meta.dataType === "float64" ? values : Float32Array.from(values);
    return { data, shape: shape.slice(), stride: cStrides(shape) };
  }

  encode(): never {
    throw new Error("gribberish codec is read-only");
  }
}

/**
 * Register a lazy codec factory once; registration does not load the wasm.
 *
 * @param registry A zarrita registry. Omitted, import the default registry lazily.
 * @returns Resolves when registration is complete; await before opening an array.
 */
export async function registerGribberishCodec(registry?: CodecRegistry): Promise<void> {
  const target = registry ?? (await import("zarrita")).registry;
  if (target.has("gribberish")) return;
  // zarrita 0.7.5 types registry codecs as numcodecs byte-to-byte codecs even
  // for array_to_bytes. Keep the adaptation here; decode's chunk type stays exact.
  target.set("gribberish", async () => GribberishCodec as unknown as RegistryEntry);
}
