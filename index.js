// OpenCode resolves a local plugin directory by looking for `index.js` at the
// package root; it does not read `main` or `exports`. Keep this shim in place.
export * from "./dist/index.js"
export { default } from "./dist/index.js"
