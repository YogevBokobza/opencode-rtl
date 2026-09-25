import assert from "node:assert/strict"
import test from "node:test"
import { formatRtlText, normalizeOptions } from "../dist/core.js"
import { rewriteAssistantStream } from "../dist/stream.js"

const OPTIONS = normalizeOptions({})
const format = (text) => formatRtlText(text, "auto", OPTIONS)

const RLI = "⁧"
const PDI = "⁩"

function sse(chunks) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

function frame(payload, event) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload)
  return (event ? `event: ${event}\n` : "") + `data: ${data}\n\n`
}

async function run(chunks) {
  const output = await rewriteAssistantStream(sse(chunks), format).text()
  const payloads = []
  for (const block of output.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue
    const line = block.split(/\r?\n/).find((entry) => entry.startsWith("data:"))
    if (!line) continue
    const data = line.slice(5).trim()
    payloads.push(data === "[DONE]" ? data : JSON.parse(data))
  }
  return { output, payloads }
}

/** The whole point: streamed output must equal a single whole-message pass. */
function assertMatchesWholeTextPass(streamed, source) {
  assert.equal(streamed, format(source))
}

const MIXED = [
  "سلام opencode",
  "",
  "```js",
  "const x = 1",
  "```",
  "",
  "متن دیگر",
  "",
].join("\n")

/** Splits text the way a provider would: arbitrary small pieces. */
function shred(text, size) {
  const pieces = []
  for (let index = 0; index < text.length; index += size) pieces.push(text.slice(index, index + size))
  return pieces
}

test("anthropic: isolates text deltas and matches a whole-message pass", async () => {
  const chunks = [
    frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...shred(MIXED, 7).map((text) =>
      frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "message_stop" }),
  ]

  const { payloads } = await run(chunks)
  const text = payloads
    .filter((entry) => entry.type === "content_block_delta")
    .map((entry) => entry.delta.text)
    .join("")

  assertMatchesWholeTextPass(text, MIXED)
  assert.match(text, /^⁧/)
  assert.match(text, /```js\nconst x = 1\n```/)
  assert.ok(payloads.some((entry) => entry.type === "content_block_stop"))
  assert.ok(payloads.some((entry) => entry.type === "message_stop"))
})

test("anthropic: leaves thinking deltas alone", async () => {
  const { payloads } = await run([
    frame({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "سلام\n\n" } }),
    frame({ type: "content_block_stop", index: 0 }),
  ])
  assert.equal(payloads[0].delta.thinking, "سلام\n\n")
})

test("anthropic: flushes a trailing block with no closing newline", async () => {
  const source = "سلام"
  const { payloads } = await run([
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: source } }),
    frame({ type: "content_block_stop", index: 0 }),
  ])
  const text = payloads
    .filter((entry) => entry.type === "content_block_delta")
    .map((entry) => entry.delta.text)
    .join("")
  assertMatchesWholeTextPass(text, source)
  assert.equal(text, `${RLI}${source}${PDI}`)
})

test("anthropic: tracks two concurrent text blocks independently", async () => {
  const { payloads } = await run([
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "اول" } }),
    frame({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "second" } }),
    frame({ type: "content_block_stop", index: 0 }),
    frame({ type: "content_block_stop", index: 1 }),
  ])
  const byIndex = new Map()
  for (const entry of payloads) {
    if (entry.type !== "content_block_delta") continue
    byIndex.set(entry.index, (byIndex.get(entry.index) ?? "") + entry.delta.text)
  }
  assert.equal(byIndex.get(0), `${RLI}اول${PDI}`)
  assert.equal(byIndex.get(1), "second")
})

test("openai chat completions: isolates delta content and flushes on finish_reason", async () => {
  const template = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "gpt" }
  const chunks = [
    ...shred(MIXED, 9).map((content) =>
      frame({ ...template, choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
    ),
    frame({ ...template, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    frame("[DONE]"),
  ]

  const { payloads } = await run(chunks)
  const text = payloads
    .filter((entry) => entry !== "[DONE]")
    .flatMap((entry) => entry.choices)
    .map((choice) => choice.delta.content ?? "")
    .join("")

  assertMatchesWholeTextPass(text, MIXED)
  assert.equal(payloads.at(-1), "[DONE]")
})

test("openai responses: isolates deltas and the terminal full text", async () => {
  const key = { item_id: "msg_1", output_index: 0, content_index: 0 }
  const chunks = [
    ...shred(MIXED, 11).map((delta) => frame({ type: "response.output_text.delta", ...key, delta })),
    frame({ type: "response.output_text.done", ...key, text: MIXED }),
    frame({
      type: "response.completed",
      response: { output: [{ type: "message", content: [{ type: "output_text", text: MIXED }] }] },
    }),
  ]

  const { payloads } = await run(chunks)
  const streamed = payloads
    .filter((entry) => entry.type === "response.output_text.delta")
    .map((entry) => entry.delta)
    .join("")

  assertMatchesWholeTextPass(streamed, MIXED)

  const done = payloads.find((entry) => entry.type === "response.output_text.done")
  assert.equal(done.text, format(MIXED))
  assert.equal(streamed, done.text)

  const completed = payloads.find((entry) => entry.type === "response.completed")
  assert.equal(completed.response.output[0].content[0].text, format(MIXED))
})

test("gemini: isolates candidate parts and flushes on finishReason", async () => {
  const chunks = [
    ...shred(MIXED, 13).map((text) => frame({ candidates: [{ index: 0, content: { role: "model", parts: [{ text }] } }] })),
    frame({ candidates: [{ index: 0, content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }] }),
  ]

  const { payloads } = await run(chunks)
  const text = payloads
    .flatMap((entry) => entry.candidates)
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")

  assertMatchesWholeTextPass(text, MIXED)
})

test("gemini: leaves thought parts alone", async () => {
  const { payloads } = await run([
    frame({ candidates: [{ index: 0, content: { parts: [{ text: "سلام\n\n", thought: true }] }, finishReason: "STOP" }] }),
  ])
  assert.equal(payloads[0].candidates[0].content.parts[0].text, "سلام\n\n")
})

test("survives frames split across arbitrary read boundaries", async () => {
  const whole = [
    frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: MIXED } }),
    frame({ type: "content_block_stop", index: 0 }),
  ].join("")

  const { payloads } = await run(shred(whole, 5))
  const text = payloads
    .filter((entry) => entry.type === "content_block_delta")
    .map((entry) => entry.delta.text)
    .join("")
  assertMatchesWholeTextPass(text, MIXED)
})

test("passes through non-SSE responses untouched", async () => {
  const body = JSON.stringify({ content: [{ type: "text", text: "سلام" }] })
  const response = new Response(body, { headers: { "content-type": "application/json" } })
  const rewritten = rewriteAssistantStream(response, format)
  assert.equal(rewritten, response)
  assert.equal(await rewritten.text(), body)
})

test("passes through bodyless responses untouched", () => {
  const response = new Response(null, { status: 204, headers: { "content-type": "text/event-stream" } })
  assert.equal(rewriteAssistantStream(response, format), response)
})

test("passes through unparseable and unrecognised frames untouched", async () => {
  const chunks = [": keep-alive\n\n", "data: not json\n\n", frame({ type: "ping" }), frame("[DONE]")]
  const output = await rewriteAssistantStream(sse(chunks), format).text()
  assert.equal(output, chunks.join(""))
})

test("preserves the SSE event name and CRLF separators", async () => {
  const body =
    "event: content_block_delta\r\n" +
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "سلام\n\n" } })}\r\n\r\n`
  const output = await rewriteAssistantStream(sse([body]), format).text()
  assert.match(output, /^event: content_block_delta\r\n/)
  assert.match(output, /\r\n\r\n$/)
  assert.match(output, /⁧/)
})

test("a formatter that throws does not break the stream", async () => {
  const boom = () => {
    throw new Error("boom")
  }
  const body = frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "سلام\n\n" } })
  const output = await rewriteAssistantStream(sse([body]), boom).text()
  assert.equal(output, body)
})

test("keeps a fenced code block intact when it spans many deltas", async () => {
  const source = ["```", "const dir = راست", "```", "", "سلام", ""].join("\n")
  const chunks = [
    ...shred(source, 3).map((text) => frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
    frame({ type: "content_block_stop", index: 0 }),
  ]
  const { payloads } = await run(chunks)
  const text = payloads
    .filter((entry) => entry.type === "content_block_delta")
    .map((entry) => entry.delta.text)
    .join("")

  assertMatchesWholeTextPass(text, source)
  assert.match(text, /```\nconst dir = راست\n```/)
})
