// Starfleet's minimal OpenCode OTEL plugin.
//
// Why this exists
// ---------------
// `@devtheops/opencode-plugin-otel` calls `trace.setGlobalTracerProvider(provider)`
// at startup, REPLACING any TracerProvider that was already registered. That
// breaks Effect's `@effect/opentelemetry` machinery: Effect's per-request HTTP
// server spans (the ones created by `effect/unstable/http/HttpMiddleware.tracer`)
// stop reaching the OTLP exporter, so Jaeger never sees them and downstream
// trace stitching falls apart.
//
// What this does instead
// ----------------------
// We install a `NodeTracerProvider` for the AI SDK and other raw
// `@opentelemetry/api` consumers, but we DO NOT clobber an already-registered
// provider. If one is already set we leave it alone. Either way, Effect's
// internal `OtelTracerProvider` (held in the Effect Context, with its own
// BatchSpanProcessor → OTLP) keeps exporting Effect spans untouched.
//
// Endpoint resolution: prefer `OPENCODE_OTLP_ENDPOINT` (Tesseract sets this
// alongside `OTEL_EXPORTER_OTLP_ENDPOINT` to disambiguate from any user OTEL
// env vars that may be set in the workspace shell), fall back to
// `OTEL_EXPORTER_OTLP_ENDPOINT`. If neither is set the plugin is a no-op.

import type { Plugin, PluginModule } from "@opencode-ai/plugin"

let registered = false

const start: Plugin = async () => {
  const endpoint = process.env.OPENCODE_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint) return {}
  if (registered) return {}
  registered = true

  const { trace, ProxyTracerProvider } = await import("@opentelemetry/api")
  const SdkTraceBase = await import("@opentelemetry/sdk-trace-base")
  const SdkTraceNode = await import("@opentelemetry/sdk-trace-node")
  const Otlp = await import("@opentelemetry/exporter-trace-otlp-http")

  // Diagnostic: log what global TracerProvider is currently registered.
  const existing = trace.getTracerProvider()
  const existingTag =
    existing instanceof ProxyTracerProvider
      ? `ProxyTracerProvider(delegate=${existing.getDelegate()?.constructor?.name ?? "Noop"})`
      : (existing.constructor?.name ?? "unknown")
  console.log(`[starfleet-otel] before register: global TracerProvider = ${existingTag}, endpoint=${endpoint}`)

  // If something already registered a real (non-noop) global provider, do
  // nothing. Effect's `@effect/opentelemetry` does NOT call register() (see
  // its NodeSdk.ts:layerTracerProvider — it constructs a NodeTracerProvider
  // and holds it in the Effect Context, never registering globally), so in
  // the normal opencode boot the global is still the noop ProxyTracerProvider
  // and we install a real provider here.
  if (existing instanceof ProxyTracerProvider) {
    const delegate = existing.getDelegate()
    // ProxyTracerProvider holds a delegate; if it's already a real provider
    // someone else installed, leave it alone.
    if (
      delegate instanceof SdkTraceNode.NodeTracerProvider ||
      delegate instanceof SdkTraceBase.BasicTracerProvider
    ) {
      console.log(`[starfleet-otel] global already has a real delegate, skipping registration`)
      return {}
    }
  } else if (
    existing instanceof SdkTraceNode.NodeTracerProvider ||
    existing instanceof SdkTraceBase.BasicTracerProvider
  ) {
    console.log(`[starfleet-otel] global is already a real provider, skipping registration`)
    return {}
  }

  const provider = new SdkTraceNode.NodeTracerProvider({
    spanProcessors: [
      new SdkTraceBase.BatchSpanProcessor(
        new Otlp.OTLPTraceExporter({
          url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
        }),
      ),
    ],
  })
  provider.register()
  console.log(`[starfleet-otel] registered NodeTracerProvider as global, exporting to ${endpoint}/v1/traces`)

  const shutdown = () => {
    provider
      .forceFlush()
      .catch(() => {})
      .finally(() => provider.shutdown().catch(() => {}))
  }
  process.once("beforeExit", shutdown)
  process.once("SIGTERM", shutdown)
  process.once("SIGINT", shutdown)

  return {}
}

const Plugin: PluginModule = {
  id: "starfleet-otel",
  server: start,
}

export default Plugin

