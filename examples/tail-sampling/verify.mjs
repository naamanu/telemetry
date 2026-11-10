import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const binary = process.argv[2];
assert.ok(binary, "Usage: node verify.mjs /absolute/path/to/otelcol-contrib");
const received = [];
const sink = createServer(async (request, response) => {
  try {
    assert.equal(request.headers.authorization, "Bearer td_live_local_test");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    received.push({
      path: request.url,
      data: JSON.parse(request.headers["content-encoding"] === "gzip" ? gunzipSync(body) : body),
    });
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  } catch (error) {
    response.writeHead(400).end(String(error));
  }
});
sink.listen(0, "127.0.0.1");
await once(sink, "listening");

// Reserve a second ephemeral port for the Collector's OTLP receiver.
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const receiverPort = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));

const directory = await mkdtemp(join(tmpdir(), "telemetry-tail-sampling-"));
const override = join(directory, "exporter.yaml");
// JSON is valid YAML; override only the wire encoding so the local sink needs no dependencies.
await writeFile(
  override,
  JSON.stringify({ exporters: { "otlp_http/telemetry": { encoding: "json" } } }),
);
const collector = spawn(
  binary,
  [`--config=${fileURLToPath(new URL("collector.yaml", import.meta.url))}`, `--config=${override}`],
  {
    env: {
      ...process.env,
      TELEMETRY_DEV_API_KEY: "td_live_local_test",
      TELEMETRY_DEV_BASE_URL: `http://127.0.0.1:${sink.address().port}`,
      OTEL_HTTP_ENDPOINT: `127.0.0.1:${receiverPort}`,
      TAIL_SAMPLING_DECISION_WAIT: "2s",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30000,
    killSignal: "SIGKILL",
  },
);
let logs = "";
let spawnError;
collector.stdout.on("data", (chunk) => {
  logs += chunk;
});
collector.stderr.on("data", (chunk) => {
  logs += chunk;
});
collector.on("error", (error) => {
  spawnError = error;
});
const exited = once(collector, "exit");
// An invalid executable emits error without exit; handle it in the polling loop below.
exited.catch(() => {});

async function post(path, data) {
  const response = await fetch(`http://127.0.0.1:${receiverPort}/v1/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200, await response.text());
}

const hash = (value, length) => createHash("sha256").update(value).digest("hex").slice(0, length);
const start = BigInt(Date.now()) * 1_000_000n;
const roots = [];
const children = [];
const traces = new Map();
for (const [kind, count] of [
  ["error", 20],
  ["slow", 20],
  ["healthy", 100],
]) {
  for (let i = 0; i < count; i++) {
    const name = `${kind}-${i}`;
    const traceId = hash(name, 32);
    const parentSpanId = hash(`${name}-parent`, 16);
    traces.set(traceId, kind);
    const span = {
      traceId,
      startTimeUnixNano: String(start),
      endTimeUnixNano: String(start + (kind === "slow" ? 6_000_000_000n : 100_000_000n)),
      status: { code: 1 },
    };
    roots.push({ ...span, spanId: parentSpanId, name: `${name}-parent` });
    children.push({
      ...span,
      spanId: hash(`${name}-child`, 16),
      parentSpanId,
      name: `${name}-child`,
      status: { code: kind === "error" ? 2 : 1 },
    });
  }
}
const request = (spans) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (spawnError) throw spawnError;
    assert.equal(collector.exitCode, null, `Collector stopped:\n${logs}`);
    try {
      await post("traces", { resourceSpans: [] });
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, `Collector did not start:\n${logs}`);
  await post("traces", request(roots));
  await post("traces", request(children));
  await post("logs", {
    resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: "test" } }] }] }],
  });
  await post("metrics", {
    resourceMetrics: [
      { scopeMetrics: [{ metrics: [{ name: "test", gauge: { dataPoints: [{ asInt: "1" }] } }] }] },
    ],
  });

  // Let the decision window and batch timer expire, then drain the exporter on shutdown.
  await delay(6000);
  collector.kill("SIGTERM");
  const [code] = await exited;
  assert.equal(code, 0, logs);
  const exported = received.flatMap(({ data }) =>
    (data.resourceSpans ?? []).flatMap((resource) =>
      resource.scopeSpans.flatMap((scope) => scope.spans),
    ),
  );
  const byTrace = new Map();
  for (const span of exported) {
    assert.ok(traces.has(span.traceId), `Unexpected trace: ${span.traceId}`);
    const spans = byTrace.get(span.traceId) ?? [];
    spans.push(span);
    byTrace.set(span.traceId, spans);
  }
  for (const [traceId, kind] of traces) {
    if (kind !== "healthy") assert.ok(byTrace.has(traceId), `Missing ${kind} trace ${traceId}`);
  }
  for (const spans of byTrace.values()) {
    assert.equal(
      spans.length,
      2,
      "Retained traces must include both parent and child exactly once",
    );
    const parent = spans.find((span) => span.name.endsWith("-parent"));
    const child = spans.find((span) => span.name.endsWith("-child"));
    assert.ok(parent && child);
    assert.equal(child.parentSpanId, parent.spanId);
  }
  const baseline = [...byTrace.keys()].filter((id) => traces.get(id) === "healthy").length;
  assert.ok(baseline > 0 && baseline < 100, `Expected a healthy subset; got ${baseline}/100`);
  assert.ok(
    received.some(({ path }) => path === "/v1/logs"),
    "Logs were not forwarded",
  );
  assert.ok(
    received.some(({ path }) => path === "/v1/metrics"),
    "Metrics were not forwarded",
  );
  console.log(
    `Passed: 20 error traces, 20 slow traces, ${baseline}/100 healthy traces, complete parent/child pairs, logs, and metrics.`,
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (collector.exitCode === null && !spawnError) {
    collector.kill("SIGTERM");
    await exited;
  }
  sink.closeAllConnections();
  await new Promise((resolve) => sink.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
