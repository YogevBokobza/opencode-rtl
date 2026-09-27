/**
 * OpenCode 2 removed `experimental.text.complete`, the hook that used to hand a
 * plugin the finished assistant text. The only remaining place a plugin can see
 * assistant prose before OpenCode stores and renders it is the provider's own
 * HTTP response, exposed through `session.hook("http.response")`.
 *
 * This module rewrites the assistant text deltas inside a provider SSE stream.
 * Anything it does not recognise is forwarded byte-for-byte, so an unsupported
 * protocol degrades to "no RTL isolation" instead of a broken session.
 */

export type TextFormatter = (text: string) => string

const SSE_MEDIA_TYPE = "text/event-stream"

export function rewriteAssistantStream(response: Response, format: TextFormatter): Response {
  const body = response.body
  if (!body) return response
  if (!(response.headers.get("content-type") ?? "").toLowerCase().includes(SSE_MEDIA_TYPE)) return response

  const rewriter = new SseRewriter(format)
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })

      let boundary = nextFrameBoundary(buffer)
      while (boundary) {
        const frame = buffer.slice(0, boundary.end)
        buffer = buffer.slice(boundary.end)
        controller.enqueue(encoder.encode(rewriter.frame(frame, boundary.separator)))
        boundary = nextFrameBoundary(buffer)
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      const tail = buffer ? rewriter.frame(buffer, "") : ""
      const pending = rewriter.finish()
      if (tail || pending) controller.enqueue(encoder.encode(tail + pending))
    },
  })

  return new Response(body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

/** Locates the end of the first complete SSE frame, separator included. */
function nextFrameBoundary(buffer: string): { end: number; separator: string } | undefined {
  const match = /(?:\r\n|\n|\r)(?:\r\n|\n|\r)/.exec(buffer)
  if (!match) return undefined
  return { end: match.index + match[0].length, separator: match[0] }
}

/**
 * Accumulates one assistant text stream and releases it in formatted segments.
 *
 * Formatting has to see whole Markdown blocks: a fence, a paragraph or a table
 * is only classifiable once it is complete. Segments are therefore cut at blank
 * lines outside fenced code, where formatting composes — `format(a) + format(b)`
 * equals `format(a + b)` — so streamed output stays identical to the text a
 * single whole-message pass would have produced.
 */
class TextStream {
  private pending = ""

  constructor(private readonly format: TextFormatter) {}

  push(delta: string): string {
    if (!delta) return ""
    this.pending += delta
    const cut = lastSafeSplit(this.pending)
    if (cut < 0) return ""
    const segment = this.pending.slice(0, cut)
    this.pending = this.pending.slice(cut)
    try {
      return this.format(segment)
    } catch {
      return segment
    }
  }

  flush(): string {
    if (!this.pending) return ""
    const segment = this.pending
    this.pending = ""
    try {
      return this.format(segment)
    } catch {
      return segment
    }
  }
}

/**
 * Offset just past the last blank line that sits outside a code fence, or -1
 * when the text holds no such boundary yet.
 */
function lastSafeSplit(text: string): number {
  const parts = text.split(/(\r?\n)/)
  let offset = 0
  let safe = -1
  let fence = ""

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index] ?? ""
    const newline = parts[index + 1] ?? ""
    const trimmed = line.trimStart()
    const marker = trimmed.startsWith("```") ? "```" : trimmed.startsWith("~~~") ? "~~~" : ""

    if (fence) {
      if (marker && trimmed.startsWith(fence)) fence = ""
    } else if (marker) {
      fence = marker
    }

    offset += line.length + newline.length
    if (!fence && newline && !line.trim()) safe = offset
  }

  return safe
}

type Json = Record<string, unknown>

/** Rewrites assistant text in the SSE frames of a provider response. */
class SseRewriter {
  private readonly streams = new Map<string, TextStream>()
  private readonly geminiParts = new Map<string, { candidateIndex: number; partIndex: number; role?: unknown }>()
  private separator = "\n\n"
  private eol = "\n"
  private openaiChunk: Json | undefined

  constructor(private readonly format: TextFormatter) {}

  frame(frame: string, separator: string): string {
    if (separator) {
      this.separator = separator
      this.eol = /\r\n|\n|\r/.exec(separator)?.[0] ?? "\n"
    }
    try {
      return this.rewrite(frame, separator)
    } catch {
      return frame
    }
  }

  /** Emits anything still buffered when the stream ends without a terminal event. */
  finish(): string {
    const frames: string[] = []
    for (const [key, stream] of this.streams) {
      const rest = stream.flush()
      if (rest) frames.push(...this.deltaFrames(key, rest))
    }
    this.streams.clear()
    this.geminiParts.clear()
    return frames.join("")
  }

  private rewrite(frame: string, separator: string): string {
    const parsed = parseFrame(frame, separator, this.eol)
    if (!parsed) return frame

    const payload = JSON.parse(parsed.data) as unknown
    if (!isRecord(payload)) return frame

    const original = JSON.stringify(payload)
    const extra = this.apply(payload)
    const rewritten = JSON.stringify(payload)
    return extra.join("") + (rewritten === original ? frame : parsed.render(rewritten))
  }

  /**
   * Mutates a decoded SSE payload in place and returns whole frames that must be
   * written before it — a flush of buffered text ahead of a terminal event.
   */
  private apply(payload: Json): string[] {
    const type = typeof payload.type === "string" ? payload.type : undefined

    if (type === "error" || isRecord(payload.error)) {
      this.streams.clear()
      this.geminiParts.clear()
      return []
    }

    // Anthropic Messages.
    if (type === "content_block_delta") {
      const delta = asRecord(payload.delta)
      if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
        delta.text = this.stream(anthropicKey(payload)).push(delta.text)
      }
      return []
    }
    if (type === "content_block_stop") return this.close(anthropicKey(payload))
    if (type === "message_stop") {
      const pending = this.finish()
      return pending ? [pending] : []
    }

    // OpenAI Responses.
    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      payload.delta = this.stream(responsesKey(payload)).push(payload.delta)
      return []
    }
    if (type === "response.output_text.done") {
      const frames = this.close(responsesKey(payload))
      if (typeof payload.text === "string") payload.text = this.format(payload.text)
      return frames
    }
    if (type === "response.output_item.done" || type === "response.completed") {
      formatOutputText(payload, this.format)
      return []
    }

    // OpenAI chat completions.
    if (Array.isArray(payload.choices)) {
      this.openaiChunk = payload
      for (const entry of payload.choices) {
        const choice = asRecord(entry)
        if (!choice) continue
        const key = `openai:${String(choice.index ?? 0)}`
        const delta = asRecord(choice.delta)
        if (delta && typeof delta.content === "string") {
          delta.content = this.stream(key).push(delta.content)
        }
        if (choice.finish_reason != null && delta) {
          const rest = this.streams.get(key)?.flush() ?? ""
          this.streams.delete(key)
          if (rest) delta.content = typeof delta.content === "string" ? delta.content + rest : rest
        }
      }
      return []
    }

    // Gemini.
    if (Array.isArray(payload.candidates)) {
      for (const entry of payload.candidates) {
        const candidate = asRecord(entry)
        if (!candidate) continue
        const candidateIndex = Number(candidate.index ?? 0)
        const content = asRecord(candidate.content)
        const parts = asArray(content?.parts)
        for (const [partIndex, part] of parts.entries()) {
          const record = asRecord(part)
          if (!record || record.thought === true || typeof record.text !== "string") continue
          const key = geminiKey(candidateIndex, partIndex)
          this.geminiParts.set(key, { candidateIndex, partIndex, role: content?.role })
          record.text = this.stream(key).push(record.text)
        }
        if (candidate.finishReason != null) {
          for (const [key, metadata] of this.geminiParts) {
            if (metadata.candidateIndex !== candidateIndex) continue
            const rest = this.streams.get(key)?.flush() ?? ""
            this.streams.delete(key)
            this.geminiParts.delete(key)
            if (!rest) continue
            const part = asRecord(parts[metadata.partIndex])
            if (part && typeof part.text === "string") part.text += rest
          }
        }
      }
      return []
    }

    return []
  }

  private stream(key: string): TextStream {
    let stream = this.streams.get(key)
    if (!stream) {
      stream = new TextStream(this.format)
      this.streams.set(key, stream)
    }
    return stream
  }

  private close(key: string): string[] {
    const rest = this.streams.get(key)?.flush() ?? ""
    this.streams.delete(key)
    return rest ? this.deltaFrames(key, rest) : []
  }

  /** Rebuilds a protocol-appropriate delta frame carrying buffered text. */
  private deltaFrames(key: string, text: string): string[] {
    const [protocol, ...rest] = key.split(":")

    if (protocol === "anthropic") {
      return [
        this.render("content_block_delta", {
          type: "content_block_delta",
          index: Number(rest[0] ?? 0),
          delta: { type: "text_delta", text },
        }),
      ]
    }

    if (protocol === "responses") {
      return [
        this.render("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: rest[0] ?? "",
          output_index: Number(rest[1] ?? 0),
          content_index: Number(rest[2] ?? 0),
          delta: text,
        }),
      ]
    }

    if (protocol === "openai" && this.openaiChunk) {
      const template = this.openaiChunk
      return [
        this.render(undefined, {
          id: template.id,
          object: template.object,
          created: template.created,
          model: template.model,
          choices: [{ index: Number(rest[0] ?? 0), delta: { content: text }, finish_reason: null }],
        }),
      ]
    }

    if (protocol === "gemini") {
      const metadata = this.geminiParts.get(key)
      if (!metadata) return []
      const parts: Json[] = Array.from({ length: metadata.partIndex + 1 }, () => ({}))
      parts[metadata.partIndex] = { text }
      return [
        this.render(undefined, {
          candidates: [
            {
              index: metadata.candidateIndex,
              content: { ...(metadata.role === undefined ? {} : { role: metadata.role }), parts },
            },
          ],
        }),
      ]
    }

    return []
  }

  private render(event: string | undefined, payload: unknown): string {
    const data = `data: ${JSON.stringify(payload)}`
    return (event ? `event: ${event}${this.eol}${data}` : data) + this.separator
  }
}

type ParsedFrame = {
  data: string
  /** Rebuilds the frame with a new JSON payload, keeping every other line. */
  render: (data: string) => string
}

function parseFrame(frame: string, separator: string, eol: string): ParsedFrame | undefined {
  const body = separator ? frame.slice(0, frame.length - separator.length) : frame
  const lines = body.split(/\r\n|\n|\r/)
  const dataLines: number[] = []
  const values: string[] = []

  lines.forEach((line, index) => {
    if (!line.startsWith("data:")) return
    dataLines.push(index)
    values.push(line.slice(5).replace(/^ /, ""))
  })

  if (!dataLines.length) return undefined
  const data = values.join("\n")
  if (data === "[DONE]" || !data.trim().startsWith("{")) return undefined

  return {
    data,
    render: (replacement) => {
      const rebuilt = [...lines]
      rebuilt[dataLines[0]!] = `data: ${replacement}`
      for (const index of dataLines.slice(1)) rebuilt[index] = undefined as unknown as string
      return rebuilt.filter((line) => line !== undefined).join(eol) + separator
    },
  }
}

function anthropicKey(payload: Json): string {
  return `anthropic:${String(payload.index ?? 0)}`
}

function responsesKey(payload: Json): string {
  return `responses:${String(payload.item_id ?? "")}:${String(payload.output_index ?? 0)}:${String(payload.content_index ?? 0)}`
}

function geminiKey(candidateIndex: number, partIndex: number): string {
  return `gemini:${candidateIndex}:${partIndex}`
}

/** Formats every `output_text` part reachable in a terminal Responses payload. */
function formatOutputText(value: unknown, format: TextFormatter): void {
  if (Array.isArray(value)) {
    for (const entry of value) formatOutputText(entry, format)
    return
  }
  const record = asRecord(value)
  if (!record) return
  if (record.type === "output_text" && typeof record.text === "string") {
    record.text = format(record.text)
    return
  }
  for (const entry of Object.values(record)) formatOutputText(entry, format)
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Json | undefined {
  return isRecord(value) ? value : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
