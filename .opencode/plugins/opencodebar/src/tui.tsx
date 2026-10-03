import { Plugin } from "@opencode/plugin/tui"

/**
 * CLI entry point for opencodebar. Placeholder scaffold: registers an empty
 * sidebar slot. The full cost panel is wired in later commits.
 */
export default Plugin.define({
  id: "opencodebar",
  setup(context) {
    return context.ui.slot({
      append: "sidebar.content",
      render: () => null,
    })
  },
})
