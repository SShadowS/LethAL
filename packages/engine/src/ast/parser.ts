// The engine's parse entry point. Backed by the WASM reference until the RUST-03 switch (S3.4).
export { initWasmParser as initParser, parseALWasm as parseAL } from "./parser-wasm";
