import assert from "node:assert/strict"
import test from "node:test"
import { Host } from "@opencode/plugin/host"
import plugin from "opencode-rtl"
import serverPlugin from "opencode-rtl/server"

async function hooks(options = {}) {
  const registered = {}
  const domain = (name) => ({
    async hook(event, callback) {
      registered[`${name}.${event}`] = callback
      return { async dispose() {} }
    },
  })
  await plugin.setup({ options, session: domain("session"), tool: domain("tool"), shell: domain("shell") })
  return registered
}

test("V2 host resolves and loads a default definition; V1 server remains callable", async () => {
  const entry = Host.resolve({ directory: process.cwd(), name: "opencode-rtl" }).server
  assert.ok(entry)
  const loaded = await Host.load(entry)
  assert.equal(loaded.default, plugin)
  const localEntry = Host.resolve({ directory: `${process.cwd()}/dist` }).server
  assert.ok(localEntry)
  assert.equal((await Host.load(localEntry)).default, plugin)
  assert.equal(plugin, serverPlugin)
  assert.equal(typeof plugin.id, "string")
  assert.equal(typeof plugin.setup, "function")
  const legacy = await plugin.server({ client: {} })
  const output = { text: "שלום" }
  await legacy["experimental.text.complete"]({}, output)
  assert.equal(output.text, "\u2067שלום\u2069")
})

test("V2 formats user context and adds guidance without mutating history or other content", async () => {
  const registered = await hooks({ language: "he", wrapRtlMarkdown: "always" })
  const messages = [
    { role: "user", content: [{ type: "text", text: "שלום\n```js\nconst x = 1\n```" }, { type: "file", uri: "file:///שלום" }] },
    { role: "assistant", content: [{ type: "text", text: "שלום" }] },
  ]
  const original = structuredClone(messages)
  const event = { system: [], messages }
  registered["session.context"](event)
  assert.match(event.system[0].text, /Hebrew/)
  assert.equal(event.messages[0].content[0].text, "\u2067שלום\u2069\n```js\nconst x = 1\n```")
  assert.deepEqual(messages, original)
  assert.deepEqual(event.messages[0].content[1], original[0].content[1])
  assert.deepEqual(event.messages[1], original[1])
  const nextRequest = { system: [], messages }
  registered["session.context"](nextRequest)
  assert.deepEqual(nextRequest, event)
  for (const kind of ["compaction", "generate", "title"]) {
    const auxiliary = { system: [], messages }
    registered[`session.${kind}`](auxiliary)
    assert.deepEqual(auxiliary, event)
  }
})

test("V2 formats tool text while preserving structured output, files, and errors", async () => {
  const registered = await hooks({ isolateToolOutput: "auto" })
  const after = registered["tool.execute.after"]
  const file = { type: "file", uri: "file:///שלום", mime: "text/plain" }
  for (const content of ["שלום", [{ type: "text", text: "שלום" }, file]]) {
    const event = { status: "completed", result: { content, output: { text: "שלום" }, metadata: { title: "test" } } }
    after(event)
    assert.deepEqual(event.result.content, typeof content === "string" ? "\u2067שלום\u2069" : [{ type: "text", text: "\u2067שלום\u2069" }, file])
    assert.deepEqual(event.result.output, { text: "שלום" })
    assert.deepEqual(event.result.metadata, { title: "test" })
  }
  const failure = { status: "error", error: { message: "שלום" } }
  after(failure)
  assert.deepEqual(failure, { status: "error", error: { message: "שלום" } })
  const structured = { status: "completed", result: { output: { text: "שלום" } } }
  after(structured)
  assert.deepEqual(structured.result, { output: { text: "שלום" } })
})

test("V2 honors disabled options and shell environment settings", async () => {
  for (const options of [{ enabled: false }, { systemGuidance: false, isolateUserMessages: "off" }]) {
    const registered = await hooks(options)
    const event = { system: [], messages: [{ role: "user", content: [{ type: "text", text: "שלום" }] }] }
    const original = structuredClone(event)
    registered["session.context"](event)
    assert.deepEqual(event, original)
    const tool = { status: "completed", result: { content: "שלום" } }
    registered["tool.execute.after"](tool)
    assert.equal(tool.result.content, "שלום")
  }
  const registered = await hooks({ language: "he", enabled: false })
  const shell = { env: { EXISTING: "value" } }
  registered["shell.create.before"](shell)
  assert.deepEqual(shell.env, { EXISTING: "value", OPENCODE_RTL: "0", OPENCODE_RTL_LANGUAGE: "he", OPENCODE_RTL_USER_ISOLATION: "auto", OPENCODE_RTL_ASSISTANT_ISOLATION: "off" })
  const disabled = await hooks({ directionEnv: false })
  const untouched = { env: {} }
  disabled["shell.create.before"](untouched)
  assert.deepEqual(untouched.env, {})
})
