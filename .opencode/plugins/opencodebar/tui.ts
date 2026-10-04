// Discovery entrypoint: OpenCode discovers project TUI plugins at
// .opencode/plugins/<name>/tui.ts. JSX stays in src/tui.tsx (loaded through
// package.json exports when installed as a package); this file only forwards
// the default export so discovery and package layouts stay in sync.
export { default } from "./src/tui.tsx"
