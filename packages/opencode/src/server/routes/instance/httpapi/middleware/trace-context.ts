import { context as otelContext, propagation, ROOT_CONTEXT, trace as otelTrace } from "@opentelemetry/api"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

// Extracts a W3C distributed trace context (traceparent / tracestate) from
// the incoming HTTP headers and continues it as the parent of the Effect
// span tree for the rest of the request pipeline. Downstream Effect spans
// (including AI SDK calls) inherit the upstream span as their parent so
// traces stitch end-to-end across services.
//
// This uses `OtelTracer.withSpanContext` (which calls
// `Effect.withParentSpan(makeExternalSpan(...))`) to attach an external
// parent span to the inner effect. Effect's tracer then walks the parent
// chain when creating new spans, picking up the upstream `traceId` and
// `spanId`.
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
    if (!sc || !sc.traceId || sc.traceId === "00000000000000000000000000000000") {
      return yield* effect
    }

    console.log(
      `[trace-context] continuing trace_id=${sc.traceId} span_id=${sc.spanId} url=${request.url}`,
    )

    return yield* OtelTracer.withSpanContext(effect, sc) as Effect.Effect<unknown, unknown, unknown>
  }) as any,
).layer as unknown as Layer.Layer<never, never, never>
