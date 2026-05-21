import { propagation, ROOT_CONTEXT, trace as otelTrace } from "@opentelemetry/api"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// Extracts a W3C distributed trace context (traceparent / tracestate) from
// the incoming HTTP headers and attaches it as the Effect parent span for
// the rest of the request pipeline. `OtelTracer.withSpanContext(effect,
// sc)` is `Effect.withParentSpan(effect, makeExternalSpan(sc))`, so
// `Effect.fn(...)` and `Effect.withSpan` calls inside the route handler
// inherit `sc` as their parent.
//
// NOTE (2026-05-21): in this codebase the framework's
// `HttpMiddleware.tracer` (effect/unstable/http/HttpMiddleware.ts) already
// parses W3C `traceparent` headers natively and creates a "POST /…" server
// span as a child of the upstream span. So setting `Tracer.ParentSpan`
// here is redundant for the synchronous portion of the request — but it
// also doesn't hurt, and we keep it as a belt-and-suspenders measure.
//
// Stitching beyond the synchronous handler (i.e. into the long-lived
// per-instance scopes where SessionPrompt.run / LLM.run / ai.streamText
// actually execute) is NOT achieved by this middleware alone. opencode
// forks per-request work into shared `InstanceState` scopes whose own
// span lineage was captured at server bootstrap, so spans created by
// background fibers are children of a long-lived "phantom" bootstrap span
// that's never exported, not of the upstream span. Genuine end-to-end
// stitching would require stripping `Tracer.ParentSpan` (or rerooting
// from `request.headers["traceparent"]`) at the boundary where work
// crosses into those long-lived scopes.
//
// A `x-trace-continued: <traceId>` response header is added when the
// middleware extracted an upstream trace context, as a debugging aid.
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
