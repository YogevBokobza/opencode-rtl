import assert from "node:assert/strict"
import test from "node:test"
import plugin from "../dist/server.js"
import tui from "../dist/tui.js"
import { formatRtlText, normalizeOptions } from "../dist/core.js"

/** Minimal stand-in for the OpenCode 2 plugin context. */
function makeContext(options = {}) {
  const hooks = new Map()
  const record = (domain) => (name, callback) => {
    hooks.set(`${domain}.${name}`, callback)
    return Promise.resolve({ dispose: async () => hooks.delete(`${domain}.${name}`) })
  }
  return {
    options,
    app: { name: "opencode", version: "2.0.17", channel: "latest" },
    location: { directory: process.cwd(), project: { id: "test", directory: process.cwd(), canonical: "test" } },
    session: { hook: record("session") },
    tool: { hook: record("tool") },
    shell: { hook: record("shell") },
    hooks,
  }
}

const RLI = "⁧"
const PDI = "⁩"

test("registers the OpenCode 2 hooks it needs", async () => {
  const ctx = makeContext({ isolateToolOutput: "auto" })
  await plugin.setup(ctx)

  assert.deepEqual(
    [...ctx.hooks.keys()].sort(),
    ["session.context", "session.http.response", "session.prompt", "shell.create.before", "tool.execute.after"],
  )
})

test("does not touch provider responses when assistant isolation is off", async () => {
  const ctx = makeContext({ isolateAssistantText: "off" })
  await plugin.setup(ctx)
  assert.equal(ctx.hooks.has("session.http.response"), false)
})

test("isolates the admitted user prompt", async () => {
  const ctx = makeContext()
  await plugin.setup(ctx)

  const event = { prompt: { text: "سلام opencode" } }
  await ctx.hooks.get("session.prompt")(event)
  assert.equal(event.prompt.text, `${RLI}سلام opencode${PDI}`)
})

test("leaves an already isolated prompt alone", async () => {
  const ctx = makeContext()
  await plugin.setup(ctx)

  const once = { prompt: { text: "سلام opencode" } }
  await ctx.hooks.get("session.prompt")(once)
  const twice = { prompt: { text: once.prompt.text } }
  await ctx.hooks.get("session.prompt")(twice)
  assert.equal(twice.prompt.text, once.prompt.text)
})

test("pushes system guidance and isolates user turns on the context hook", async () => {
  const ctx = makeContext()
  await plugin.setup(ctx)

  class Message {
    constructor(role, content) {
      this.role = role
      this.content = content
    }
  }
  const event = {
    system: [],
    messages: [
      new Message("user", [{ type: "text", text: "سلام opencode" }]),
      new Message("assistant", [{ type: "text", text: "سلام" }]),
    ],
    options: {},
  }
  await ctx.hooks.get("session.context")(event)

  assert.equal(event.system.length, 1)
  assert.equal(event.system[0].type, "text")
  assert.match(event.system[0].text, /RTL language support is active/)

  assert.equal(event.messages[0].content[0].text, `${RLI}سلام opencode${PDI}`)
  assert.ok(event.messages[0] instanceof Message, "keeps the message class prototype")
  assert.equal(event.messages[1].content[0].text, "سلام", "assistant turns are left to the stream rewriter")
})

test("isolates tool output only when enabled", async () => {
  const off = makeContext()
  await plugin.setup(off)
  const unchanged = { status: "completed", result: { content: "سلام" } }
  await off.hooks.get("tool.execute.after")(unchanged)
  assert.equal(unchanged.result.content, "سلام")

  const on = makeContext({ isolateToolOutput: "always" })
  await on.setup?.()
  await plugin.setup(on)

  const asString = { status: "completed", result: { content: "سلام" } }
  await on.hooks.get("tool.execute.after")(asString)
  assert.equal(asString.result.content, `${RLI}سلام${PDI}`)

  const asParts = {
    status: "completed",
    result: { content: [{ type: "text", text: "سلام" }, { type: "file", uri: "file:///a", mime: "text/plain" }] },
  }
  await on.hooks.get("tool.execute.after")(asParts)
  assert.equal(asParts.result.content[0].text, `${RLI}سلام${PDI}`)
  assert.deepEqual(asParts.result.content[1], { type: "file", uri: "file:///a", mime: "text/plain" })

  const failed = { status: "error", error: { message: "سلام" } }
  await on.hooks.get("tool.execute.after")(failed)
  assert.deepEqual(failed.error, { message: "سلام" })
})

test("exposes direction settings to shells", async () => {
  const ctx = makeContext({ language: "fa" })
  await plugin.setup(ctx)

  const event = { env: {} }
  await ctx.hooks.get("shell.create.before")(event)
  assert.deepEqual(event.env, {
    OPENCODE_RTL: "1",
    OPENCODE_RTL_LANGUAGE: "fa",
    OPENCODE_RTL_USER_ISOLATION: "auto",
    OPENCODE_RTL_ASSISTANT_ISOLATION: "auto",
  })

  const disabled = makeContext({ directionEnv: false })
  await plugin.setup(disabled)
  const untouched = { env: {} }
  await disabled.hooks.get("shell.create.before")(untouched)
  assert.deepEqual(untouched.env, {})
})

test("rewrites only the primary provider stream", async () => {
  const ctx = makeContext()
  await plugin.setup(ctx)
  const hook = ctx.hooks.get("session.http.response")

  const sse = () =>
    new Response(
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "سلام\n\n" } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )

  const primary = { kind: "primary", response: sse() }
  await hook(primary)
  assert.match(await primary.response.text(), /⁧سلام⁩/)

  const title = { kind: "title", response: sse() }
  const original = title.response
  await hook(title)
  assert.equal(title.response, original)

  const failed = { kind: "primary", response: new Response("nope", { status: 500 }) }
  const failedOriginal = failed.response
  await hook(failed)
  assert.equal(failed.response, failedOriginal)
})

test("honours enabled: false", async () => {
  const ctx = makeContext({ enabled: false })
  await plugin.setup(ctx)

  const prompt = { prompt: { text: "سلام" } }
  await ctx.hooks.get("session.prompt")(prompt)
  assert.equal(prompt.prompt.text, "سلام")

  const event = { system: [], messages: [{ role: "user", content: [{ type: "text", text: "سلام" }] }], options: {} }
  await ctx.hooks.get("session.context")(event)
  assert.equal(event.system.length, 0)
  assert.equal(event.messages[0].content[0].text, "سلام")

  assert.equal(ctx.hooks.has("session.http.response"), false)
})

test("the CLI plugin registers its commands and toasts", () => {
  const toasts = []
  const layers = []
  const context = {
    options: { notifyOnStart: true },
    ui: { toast: { show: (input) => toasts.push(input) } },
    keymap: { layer: (input) => layers.push(input()) },
  }

  tui.setup(context)

  assert.equal(toasts.length, 1)
  assert.equal(toasts[0].title, "RTL support loaded")
  assert.equal(toasts[0].message, statusOf({ notifyOnStart: true }))

  const commands = layers[0].commands
  assert.deepEqual(commands.map((command) => command.id), ["rtl.status", "rtl.sample"])

  commands[0].run()
  assert.equal(toasts[1].title, "RTL support")
  commands[1].run()
  assert.equal(toasts[2].title, "RTL sample")
  assert.match(toasts[2].message, /direction=rtl/)
})

function statusOf(options) {
  const settings = normalizeOptions(options)
  return [
    `enabled=${settings.enabled}`,
    `language=${settings.language}`,
    `user=${settings.isolateUserMessages}`,
    `assistant=${settings.isolateAssistantText}`,
    `tools=${settings.isolateToolOutput}`,
    `digits=${settings.digitMode}`,
    `force=${settings.forceDirection}`,
    `align=${settings.alignRtlParagraphs}`,
    `wrap=${settings.wrapRtlMarkdown}`,
  ].join(" ")
}

test("the isolation applied to a stream equals a whole-message pass", async () => {
  const ctx = makeContext()
  await plugin.setup(ctx)

  const source = ["سلام opencode", "", "```sh", "ls -la", "```", ""].join("\n")
  const frames = source
    .split("")
    .map((text) => `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`)
    .join("")
  const event = {
    kind: "primary",
    response: new Response(frames + `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    }),
  }
  await ctx.hooks.get("session.http.response")(event)

  const streamed = (await event.response.text())
    .split(/\n\n/)
    .map((block) => block.split("\n").find((line) => line.startsWith("data:")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice(5)))
    .filter((payload) => payload.type === "content_block_delta")
    .map((payload) => payload.delta.text)
    .join("")

  assert.equal(streamed, formatRtlText(source, "auto", normalizeOptions({})))
})
