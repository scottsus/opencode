import { context as otelContext, propagation, ROOT_CONTEXT } from "@opentelemetry/api"
import { Effect, Exit, Layer } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

// Extracts a W3C distributed trace context (traceparent / tracestate) from
// the incoming HTTP headers and continues it as the active OpenTelemetry
// context for the rest of the request pipeline. Downstream Effect spans
// (including AI SDK calls) inherit the upstream span as their parent so
// traces stitch end-to-end across services.
//
// The extracted context is bound for the inner effect by entering an
// `otelContext.with` scope around the synchronous `Effect.runPromiseExit`
// call. The global `AsyncLocalStorageContextManager` registered in
// `core/effect/observability.ts` propagates the bound OTEL context through
// every `await` boundary inside the inner effect's fiber.
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

    const ctx = yield* Effect.context()
    const bridged = Effect.callback<unknown, unknown>((resume) => {
      otelContext.with(extracted, () => {
        const provided = (effect as any).pipe(Effect.provide(ctx as any))
        Effect.runPromiseExit(provided as Effect.Effect<unknown, unknown, never>).then((exit) =>
          resume(Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause)),
        )
      })
    })
    return (yield* (bridged as any)) as never
  }) as any,
).layer as unknown as Layer.Layer<never, never, never>
