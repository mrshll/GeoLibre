// Vite emits the vendored GRIB decoder as an asset loaded on the first read.
declare module "*gribwasm_bg.wasm?url" {
  const url: string;
  export default url;
}
