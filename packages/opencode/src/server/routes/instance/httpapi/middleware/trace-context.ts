import { context as otelContext, propagation, ROOT_CONTEXT, trace as otelTrace } from "@opentelemetry/api"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { Effect, Exit, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// Extracts a W3C distributed trace context (traceparent / tracestate) from
// the incoming HTTP headers and continues it as the parent of the Effect
// span tree for the rest of the request pipeline.
//
// Two complementary mechanisms keep the upstream context intact:
//
// 1. `OtelTracer.withSpanContext` attaches the upstream span as the Effect
//    parent span via `Effect.withParentSpan`, so `Effect.fn(...)` and
//    `Effect.withSpan` calls inside the handler walk back to it.
// 2. `otelContext.with(extracted, ...)` binds the extracted OTEL context
//    for the duration of the inner effect's execution, so non-Effect
//    callers (the AI SDK, raw `tracer.startActiveSpan` calls, etc.) also
//    pick up the upstream span as the active parent.
//
// A `x-trace-continued: <traceId>` response header is added when the
// middleware successfully continued an upstream trace, mainly as a
// debugging aid for callers (e.g. Tesseract) verifying end-to-end
// stitching.
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

    const span = otelTrace.getSpan(extracted)
    const sc = span?.spanContext()
    const valid = sc && sc.traceId && sc.traceId !== "00000000000000000000000000000000"

    if (!valid) {
      return yield* effect
    }

    const wrapped = OtelTracer.withSpanContext(effect as any, sc) as Effect.Effect<unknown, unknown, unknown>
    const ctx = yield* Effect.context()
    const result = yield* Effect.callback<unknown, unknown>((resume) => {
      otelContext.with(extracted, () => {
        const provided = wrapped.pipe(Effect.provide(ctx as any)) as Effect.Effect<unknown, unknown, never>
        Effect.runPromiseExit(provided).then((exit) =>
          resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)),
        )
      })
    })

    if (HttpServerResponse.isHttpServerResponse(result)) {
      return HttpServerResponse.setHeader(result, "x-trace-continued", sc.traceId) as never
    }
    return result as never
  }) as any,
).layer as unknown as Layer.Layer<never, never, never>
