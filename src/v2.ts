import type { Plugin } from "@opencode/plugin"
import { PLUGIN_ID, formatRtlText, normalizeOptions, statusText, systemPrompt } from "./core.js"

export const setup: Plugin.Plugin["setup"] = async (ctx) => {
  const settings = normalizeOptions(ctx.options)
  const modelInputSettings = { ...settings, wrapRtlMarkdown: "off" as const }

  if (settings.debug) console.info(`[${PLUGIN_ID}] ${statusText({ ...settings, isolateAssistantText: "off" })}`)

  for (const kind of ["context", "compaction", "generate", "title"] as const) {
    await ctx.session.hook(kind, (event) => {
      const prompt = systemPrompt(settings)
      if (prompt) event.system.push({ type: "text", text: prompt })
      if (!settings.enabled || settings.isolateUserMessages === "off") return

      // Format the outgoing context, preserving persisted prompts and attachment offsets.
      event.messages = event.messages.map((message) => message.role !== "user" ? message : {
        ...message,
        content: message.content.map((part) => part.type !== "text" ? part : {
          ...part,
          text: formatRtlText(part.text, settings.isolateUserMessages, modelInputSettings),
        }),
      })
    })
  }

  await ctx.tool.hook("execute.after", (event) => {
    if (!settings.enabled || settings.isolateToolOutput === "off" || event.status !== "completed") return
    const content = event.result.content
    const format = (text: string) => formatRtlText(text, settings.isolateToolOutput, settings)
    if (content === undefined) return
    event.result = {
      ...event.result,
      content: typeof content === "string" ? format(content) : content.map((part) =>
        part.type === "text" ? { ...part, text: format(part.text) } : part),
    }
  })

  await ctx.shell.hook("create.before", (event) => {
    if (!settings.directionEnv) return
    event.env.OPENCODE_RTL = settings.enabled ? "1" : "0"
    event.env.OPENCODE_RTL_LANGUAGE = settings.language
    event.env.OPENCODE_RTL_USER_ISOLATION = settings.isolateUserMessages
    // V2 has no post-generation text hook.
    event.env.OPENCODE_RTL_ASSISTANT_ISOLATION = "off"
  })
}
