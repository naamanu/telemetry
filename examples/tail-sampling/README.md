# Keep diagnostic traces with tail sampling

Send traces through an OpenTelemetry Collector to keep traces with an error span,
traces lasting at least 5 seconds, and a 10% baseline sample of the remaining traces.
The decision applies to the trace, so a failed tool call retains its successful
parent and sibling spans too, provided they arrive within the decision window.

The SDK's `sampler` decides when each span starts, before its eventual error or
duration is known. A `spanFilter` can discard individual completed spans but cannot
recover spans dropped by the sampler or retain their surrounding trace. This
example makes that decision in the Collector after collecting spans.

This is an optional deployment recipe. The SDK's defaults stay the same.

## Run the Collector

Requires Docker with Compose. From this directory:

```sh
export TELEMETRY_DEV_API_KEY="td_live_your_project_key"
docker compose config --quiet
docker compose up -d
docker compose logs -f collector
```

The pinned Collector Contrib image includes the `tail_sampling` processor.
[collector.yaml](collector.yaml) configures its three policies; a match in any
policy keeps the trace. The receiver is published only on the host's loopback
interface. Run applications on the same host for this example.

## Route application telemetry through it

In the application's shell, use the same real project key and point the SDK at
the Collector. Leave `TELEMETRY_DEV_BASE_URL` unset in the Collector's shell so
the Collector forwards to telemetry.dev, rather than back to itself.

```sh
export TELEMETRY_DEV_API_KEY="td_live_your_project_key"
export TELEMETRY_DEV_BASE_URL="http://127.0.0.1:4318"
export OTEL_TRACES_SAMPLER="always_on"
```

Existing TypeScript `init()` and Python `init()` calls read these settings.
Remove explicit `baseUrl` / `base_url` and `sampler` options that override them.
The SDK base URL also controls prompt, score, and experiment API requests; the
Collector does not proxy those APIs. Applications using them should keep their
API client pointed at telemetry.dev and route traces with a separate standard
OTLP/HTTP exporter on their own OpenTelemetry provider instead. See the
[bring-your-own OpenTelemetry setup](../../packages/otel/README.md).

Keep every upstream service recording and exporting spans: a Collector cannot
recover spans already dropped by head sampling or a span filter. `always_on`
also records children of an unsampled incoming parent, though it cannot recover
that parent's missing spans.

For an existing OpenTelemetry setup, use an OTLP/HTTP exporter with base endpoint
`http://127.0.0.1:4318` and an always-on sampler. The trace-specific endpoint is
`http://127.0.0.1:4318/v1/traces`. The Collector supplies the project Authorization
header when forwarding. It also forwards metrics and logs without tail sampling,
so SDK requests to `/v1/metrics` and `/v1/logs` continue to work.

Generate traffic and flush or shut down the SDK before the application exits.
Allow at least 30 seconds after the Collector first receives a trace, plus batch
and transport time, before looking for it in telemetry.dev. To stop the example:

```sh
docker compose down
```

## Verify without a project key

Download the **Contrib** binary for your platform from the
[Collector 0.165.0 release](https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.165.0).
With Node.js 22 or later, run from this directory:

```sh
node verify.mjs /absolute/path/to/otelcol-contrib
```

The check starts the Collector and a local OTLP sink, sends synthetic parent and
child spans in separate requests, and verifies that error and slow traces retain
both spans while healthy traces are sampled. It also checks log and metric
forwarding. It uses a fake key, shortens only the decision window, and sends
nothing to telemetry.dev.

## Deployment limits

- **Decision window:** the Collector waits 30 seconds from the first received
  span, not until it knows a trace has finished. Set `TAIL_SAMPLING_DECISION_WAIT`
  in the Collector environment longer than your trace duration plus export
  delays. Long conversations that reuse one session trace ID can outlive this
  window. Cached decisions also apply to later turns, so an initially dropped
  session can lose a later error. Prefer bounded request traces for this recipe;
  it does not guarantee complete sessions or every late failure.
- **Capacity:** `num_traces`, memory limits, and decision caches are example
  values. Size them for your arrival rate and decision window. Memory pressure,
  eviction, restart, transport failure, or shutdown before a decision can lose
  spans. Monitor Collector refusals and dropped traces.
- **Routing:** all spans of a trace must reach the same Collector instance.
  Multiple instances require routing by trace ID; ordinary round-robin balancing
  can produce incomplete traces and incorrect decisions.
- **Statistics:** the retained trace population overrepresents errors and slow
  runs. Trace-derived request counts, error rates, latency percentiles, costs,
  and telemetry.dev alert baselines can be biased or reduced. Use independently
  collected, unsampled metrics for population-level monitoring; forwarding
  metrics unchanged does not undo sampling that happened in the application.
  This recipe does not add sampling-aware weighting to the dashboard.
- **Scope:** application-to-Collector traffic is still recorded and transmitted
  in full. Sampling reduces what is forwarded to the backend. Logs and metrics
  are not sampled, so logs can refer to traces that were dropped. Redact content
  before export as usual. The unauthenticated local receiver needs authentication
  and TLS before it is exposed outside this host.

See the OpenTelemetry
[tail sampling processor documentation](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/v0.165.0/processor/tailsamplingprocessor)
for policy details, sizing, late spans, and scaling. telemetry.dev's
[alerts](https://telemetry.dev/docs/platform/alerts) already provide failure
investigation and likely-cause hints; this example concerns which trace evidence
reaches the backend.
