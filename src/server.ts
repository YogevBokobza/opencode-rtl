// Type-only: `Plugin.define` is an identity function, and keeping the import
// erased leaves the built plugin with no runtime dependencies to resolve.
import type { Plugin } from "@opencode/plugin"
import {
  PLUGIN_ID,
  formatRtlText,
  hasDirectionalIsolates,
  normalizeOptions,
  statusText,
  systemPrompt,
  type IsolationMode,
  type NormalizedRtlOptions,
} from "./core.js"
import { rewriteAssistantStream } from "./stream.js"

type MutableRecord = Record<string, unknown>

const plugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(ctx) {
    const settings = normalizeOptions(ctx.options)
    // Markdown wrappers are an output-only affordance; never send them to a model.
    const modelInput: NormalizedRtlOptions = { ...settings, wrapRtlMarkdown: "off" }
    const debug = (message: string, extra?: Record<string, unknown>) => {
      if (!settings.debug) return
      console.log(`[${PLUGIN_ID}] ${message}`, extra ?? "")
    }

    debug("initialized", { status: statusText(settings) })

    // Prompt admission: isolate the user text OpenCode persists and renders.
    await ctx.session.hook("prompt", (event) => {
      if (!settings.enabled || settings.isolateUserMessages === "off") return
      event.prompt.text = isolate(event.prompt.text, settings.isolateUserMessages, modelInput)
    })

    // Agent loop: system guidance plus isolation of the user turns sent to the model.
    await ctx.session.hook("context", (event) => {
      const prompt = systemPrompt(settings)
      if (prompt) event.system.push({ type: "text", text: prompt })

      if (settings.enabled && settings.isolateUserMessages !== "off") {
        for (let index = 0; index < event.messages.length; index++) {
          const message = event.messages[index]!
          if (message.role !== "user") continue
          const content = formatContentParts(message.content, settings.isolateUserMessages, modelInput)
          if (content) event.messages[index] = withContent(message, content)
        }
      }

      debug("context transformed", { system: Boolean(prompt), messages: event.messages.length })
    })

    await ctx.tool.hook("execute.after", (event) => {
      if (!settings.enabled || settings.isolateToolOutput === "off") return
      if (event.status !== "completed") return
      const content = event.result.content
      if (typeof content === "string") {
        event.result = { ...event.result, content: isolate(content, settings.isolateToolOutput, settings) }
        return
      }
      if (!Array.isArray(content)) return
      event.result = {
        ...event.result,
        content: content.map((part) =>
          part.type === "text" ? { ...part, text: isolate(part.text, settings.isolateToolOutput, settings) } : part,
        ),
      }
    })

    await ctx.shell.hook("create.before", (event) => {
      if (!settings.directionEnv) return
      event.env.OPENCODE_RTL = settings.enabled ? "1" : "0"
      event.env.OPENCODE_RTL_LANGUAGE = settings.language
      event.env.OPENCODE_RTL_USER_ISOLATION = settings.isolateUserMessages
      event.env.OPENCODE_RTL_ASSISTANT_ISOLATION = settings.isolateAssistantText
    })

    // Assistant prose. OpenCode 2 has no post-generation text hook, so the
    // provider's own SSE stream is where the text is isolated. See src/stream.ts.
    if (settings.enabled && settings.isolateAssistantText !== "off") {
      await ctx.session.hook("http.response", (event) => {
        if (event.kind !== "primary") return
        if (!event.response.ok) return
        event.response = rewriteAssistantStream(event.response, (text) =>
          isolate(text, settings.isolateAssistantText, settings),
        )
      })
      debug("assistant stream isolation active", { mode: settings.isolateAssistantText })
    }
  },
}

export default plugin

/**
 * Formatting is not idempotent, and the same text is seen again on every later
 * turn, so already-isolated text is left alone instead of being wrapped twice.
 */
function isolate(text: string, mode: IsolationMode, options: NormalizedRtlOptions): string {
  if (!text) return text
  if (!hasDirectionalIsolates(text)) return formatRtlText(text, mode, options)

  let result = ""
  let outsideStart = 0
  let isolatedStart = -1
  let depth = 0

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x2066 && code <= 0x2068) {
      if (depth === 0) {
        result += formatRtlText(text.slice(outsideStart, index), mode, options)
        isolatedStart = index
      }
      depth += 1
    } else if (code === 0x2069 && depth > 0) {
      depth -= 1
      if (depth === 0) {
        result += text.slice(isolatedStart, index + 1)
        outsideStart = index + 1
      }
    }
  }

  return depth === 0
    ? result + formatRtlText(text.slice(outsideStart), mode, options)
    : result + text.slice(isolatedStart)
}

/** Returns rewritten message content, or undefined when nothing changed. */
function formatContentParts(
  content: readonly unknown[],
  mode: IsolationMode,
  options: NormalizedRtlOptions,
): unknown[] | undefined {
  let changed = false
  const next = content.map((part) => {
    if (!isMutableRecord(part) || part.type !== "text" || typeof part.text !== "string") return part
    const text = isolate(part.text, mode, options)
    if (text === part.text) return part
    changed = true
    return { ...part, text }
  })
  return changed ? next : undefined
}

/** Clones a message with new content, preserving its schema class prototype. */
function withContent<T extends object>(message: T, content: unknown[]): T {
  return Object.assign(Object.create(Object.getPrototypeOf(message) as object), message, { content }) as T
}

function isMutableRecord(value: unknown): value is MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
