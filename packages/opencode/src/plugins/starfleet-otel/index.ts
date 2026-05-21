// Starfleet's minimal OpenCode OTEL plugin.
//
// Why this exists
// ---------------
// `@devtheops/opencode-plugin-otel` calls `trace.setGlobalTracerProvider(provider)`
// at startup, replacing whatever's there. It also pulls in a heavy bundle
// (~50K LOC, AI SDK metric instrumentation, session/message span collation)
// that we don't need for trace export.
//
// What this does instead
// ----------------------
// We install a `NodeTracerProvider` for the AI SDK and other raw
// `@opentelemetry/api` consumers, but we DO NOT clobber an already-registered
// provider. If one is already set we leave it alone.
//
// Effect's `@effect/opentelemetry` does NOT call `provider.register()` on its
// internal NodeTracerProvider — it holds it inside the Effect Context,
// separate from the global. That's by design (Effect spans use the Effect
// `Tracer.Tracer` ref, not the global), but it means non-Effect consumers
// like the Vercel AI SDK see only the no-op `ProxyTracerProvider` unless
// something else registers a real one. This plugin does that, minimally.
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

  // If a real (non-noop) global provider is already registered, do nothing.
  const existing = trace.getTracerProvider()
  if (existing instanceof ProxyTracerProvider) {
    const delegate = existing.getDelegate()
    if (
      delegate instanceof SdkTraceNode.NodeTracerProvider ||
      delegate instanceof SdkTraceBase.BasicTracerProvider
    ) {
      return {}
    }
  } else if (
    existing instanceof SdkTraceNode.NodeTracerProvider ||
    existing instanceof SdkTraceBase.BasicTracerProvider
  ) {
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
