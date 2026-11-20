// Backwards-compatible entry point: importing this registers <fold-captcha>.
// New integrations should use /sdk/foldpass.js (classic) or /sdk/foldpass.esm.js (module).
export * from '../sdk/foldpass.esm.js';
export { default } from '../sdk/foldpass.esm.js';
