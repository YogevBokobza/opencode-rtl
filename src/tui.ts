// Type-only: `Plugin.define` is an identity function, and keeping the import
// erased leaves the built plugin with no runtime dependencies to resolve.
import type * as Plugin from "@opencode/plugin/tui/plugin"
import { PLUGIN_ID, analyzeDirection, normalizeOptions, statusText } from "./core.js"

const plugin: Plugin.Definition = {
  id: `${PLUGIN_ID}.cli`,
  setup(context) {
    const settings = normalizeOptions(context.options)

    const showStatus = () => {
      context.ui.toast.show({
        variant: settings.enabled ? "success" : "warning",
        title: "RTL support",
        message: statusText(settings),
        duration: 6000,
      })
    }

    const analyzeSample = () => {
      const sample = "سلام opencode"
      const analysis = analyzeDirection(sample, settings)
      context.ui.toast.show({
        variant: analysis.direction === "rtl" ? "success" : "warning",
        title: "RTL sample",
        message: `direction=${analysis.direction} language=${analysis.language} ratio=${analysis.rtlRatio.toFixed(2)}`,
        duration: 6000,
      })
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "rtl.status",
          title: "RTL: Show Status",
          description: "Show current RTL plugin settings.",
          group: "RTL",
          palette: true,
          slash: { name: "rtl-status" },
          run: showStatus,
        },
        {
          id: "rtl.sample",
          title: "RTL: Analyze Sample",
          description: "Run RTL detection against a mixed-language sample.",
          group: "RTL",
          palette: true,
          slash: { name: "rtl-sample" },
          run: analyzeSample,
        },
      ],
    }))

    if (settings.notifyOnStart || settings.debug) {
      context.ui.toast.show({
        variant: settings.enabled ? "success" : "warning",
        title: "RTL support loaded",
        message: statusText(settings),
        duration: 6000,
      })
    }
  },
}

export default plugin
