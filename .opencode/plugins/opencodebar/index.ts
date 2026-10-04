// Discovery entrypoint: OpenCode discovers project plugins at
// .opencode/plugins/<name>/index.ts. The publishable package shape lives in
// src/ behind package.json exports; this shim only forwards the plugin
// definition so both layouts resolve to the same implementation.
export { default } from "./src/index.ts"
