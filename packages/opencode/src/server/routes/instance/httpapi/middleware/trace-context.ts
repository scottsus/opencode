import { propagation, ROOT_CONTEXT, trace as otelTrace } from "@opentelemetry/api"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// Extracts a W3C distributed trace context (traceparent / tracestate) from
// the incoming HTTP headers and continues it as the parent of the Effect
// span tree for the rest of the request pipeline.
//
// Implementation note: this stays on the same fiber as the rest of the
// route pipeline so the OTEL-aware Tracer installed by
// `Observability.layer` remains the active tracer. Bridging through
// `Effect.runPromiseExit` (an earlier mistake) spawns a fresh top-level
// fiber whose default tracer is the no-op `NativeSpan`, which silently
// drops every span instead of exporting it.
//
// `OtelTracer.withSpanContext` is just `Effect.withParentSpan(self,
// makeExternalSpan(spanContext))`, so `Effect.fn(...)` and
// `Effect.withSpan` calls inside the handler — and, transitively, the AI
// SDK's `streamText` spans created via the OTEL tracer — inherit the
// upstream span as their parent.
//
// A `x-trace-continued: <traceId>` response header is added when the
// middleware successfully continued an upstream trace, as a debugging aid
// for callers (e.g. Tesseract) verifying end-to-end stitching.
export const traceContextLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const headers = request.headers as Record<string, string | string[] | undefined>

    const extracted = propagation.extract(ROOT_CONTEXT, headers, {
      get(carrier, key) {
        const value = carrier[key.toLowerCase()]
        if (Array.isArray(value)) return value[0]
        return value
      },
      keys(carrier) {
        return Object.keys(carrier)
      },
    })

    const sc = otelTrace.getSpan(extracted)?.spanContext()
    if (!sc?.traceId || sc.traceId === "00000000000000000000000000000000") {
      return yield* effect
    }

    const result = yield* OtelTracer.withSpanContext(effect, sc)
    if (HttpServerResponse.isHttpServerResponse(result)) {
      return HttpServerResponse.setHeader(result, "x-trace-continued", sc.traceId)
    }
    return result
  }),
).layer
