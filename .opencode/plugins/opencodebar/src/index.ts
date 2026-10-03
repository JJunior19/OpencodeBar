import { Plugin } from "@opencode/plugin"

/**
 * Server-side entry point for opencodebar.
 *
 * opencodebar is primarily a CLI (TUI) plugin; the sidebar cost panel lives in
 * the `./tui` export. This module defines the server-side identity so the
 * package loads as a whole when installed.
 */
export default Plugin.define({
  id: "opencodebar.server",
  setup() {},
})
