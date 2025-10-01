import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  LambdaClient,
  UpdateFunctionConfigurationCommand,
} from "@aws-sdk/client-lambda";
import "dotenv/config";
import fetch from "node-fetch";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type FnMeta = { framework: string; mem: number; url: string; name: string };

const REGION = process.env.AWS_REGION || "ap-southeast-1";
const COLD_RUNS = parseInt(process.env.COLD_START_RUNS || "10", 10);
const WARM_DURATION = parseInt(process.env.WARM_DURATION_SEC || "120", 10);
const ARRIVAL_RATE = parseInt(process.env.ARRIVAL_RATE || "10", 10);

const lambda = new LambdaClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function getStackOutputs(): FnMeta[] {
  execSync(
    "cd infra && npx cdk deploy --outputs-file cdk-outputs.json --require-approval never",
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  const json = JSON.parse(fs.readFileSync("infra/cdk-outputs.json", "utf8"));
  const stack = json["LambdaBenchStack"];

  const mems = (process.env.MEM_SIZES ?? "512,1024")
    .split(",")
    .map((s) => parseInt(s.trim(), 10));
  const frameworks = ["fastify", "express", "nest"];

  const metas: FnMeta[] = [];
  for (const m of mems) {
    for (const fw of frameworks) {
      const url = stack[`url${fw}${m}`];
      const name = stack[`name${fw}${m}`];
      if (!url || !name)
        throw new Error(
          `Missing outputs for ${fw}@${m}. Got keys: ${Object.keys(stack).join(
            ", "
          )}`
        );
      metas.push({ framework: fw, mem: m, url, name });
    }
  }
  return metas;
}

async function forceColdStart(fnName: string) {
  const versionTag = Date.now().toString();
  await lambda.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: fnName,
      Environment: { Variables: { VERSION: versionTag } },
    })
  );
  // Simple wait: polling invoke readiness
  let ready = false,
    attempts = 0;
  while (!ready && attempts < 60) {
    await new Promise((r) => setTimeout(r, 2000));
    attempts++;
    try {
      // first invoke will be cold anyway; we just want update to finish
      await fetch(`http://127.0.0.1/`); // noop to skip; not invoking yet
      ready = true;
    } catch {
      /* ignore */
    }
  }
}

async function firstInvoke(url: string): Promise<number> {
  const t0 = Date.now();
  const res = await fetch(url + "/health");
  await res.text();
  return Date.now() - t0;
}

async function getInitDurationMs(
  fnName: string,
  retries = 10,
  waitMs = 1000
): Promise<number | null> {
  const group = `/aws/lambda/${fnName}`;
  // look back a few minutes in case clocks drift
  const since = Date.now() - 5 * 60 * 1000;

  for (let i = 0; i < retries; i++) {
    try {
      const out = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: group,
          startTime: since,
          filterPattern: "Init Duration",
        })
      );
      const line = out.events?.slice(-1)[0]?.message || "";
      const m = line.match(/Init Duration: ([\d.]+) ms/i);
      if (m) return parseFloat(m[1]);
    } catch (e: any) {
      // If the log group doesn't exist yet, just wait and retry
      if (
        e?.name !== "ResourceNotFoundException" &&
        e?.__type !== "ResourceNotFoundException"
      ) {
        throw e;
      }
    }
    await sleep(waitMs);
  }
  return null;
}

function runArtillery(url: string) {
  const tmpl = fs.readFileSync("bench/artillery.yml", "utf8");
  const filled = tmpl
    .replace("{{target}}", url.replace(/\/$/, ""))
    .replace("{{duration}}", String(WARM_DURATION))
    .replace("{{arrivalRate}}", String(ARRIVAL_RATE));
  const tmpPath = path.join(".", "bench", ".tmp-artillery.yml");
  fs.writeFileSync(tmpPath, filled);
  const res = spawnSync("npx", ["artillery", "run", tmpPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = res.stdout?.toString() || "";
  // naive parse: extract p50/p95/p99 if present
  const p50 = matchNum(stdout, /p50:\s*([\d.]+)/i);
  const p95 = matchNum(stdout, /p95:\s*([\d.]+)/i);
  const p99 = matchNum(stdout, /p99:\s*([\d.]+)/i);
  const rps = matchNum(stdout, /scenarios\/s:\s*([\d.]+)/i);
  const errors = matchNum(stdout, /errors:\s*(\d+)/i);
  return { p50, p95, p99, rps, errors, raw: stdout };
}

function matchNum(txt: string, re: RegExp): number | null {
  const m = txt.match(re);
  return m ? Number(m[1]) : null;
}

function summarize(label: string, arr: number[]) {
  arr = arr.filter((x) => Number.isFinite(x));
  arr.sort((a, b) => a - b);
  const q = (p: number) => arr[Math.floor((arr.length - 1) * p)];
  return {
    count: arr.length,
    min: arr[0],
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: arr[arr.length - 1],
    mean: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
  };
}

async function main() {
  const metas = getStackOutputs();
  const results: any[] = [];

  for (const meta of metas) {
    console.log(`\n=== Benchmark ${meta.framework} @ ${meta.mem}MB ===`);
    const coldInit: number[] = [];
    const coldFirst: number[] = [];

    for (let i = 0; i < COLD_RUNS; i++) {
      await forceColdStart(meta.name);

      // First invocation creates the log group and produces the INIT_REPORT/REPORT lines
      const first = await firstInvoke(meta.url);

      // Give CloudWatch a moment to ingest the event, then poll for Init Duration
      await sleep(1500);
      const init = await getInitDurationMs(meta.name, 12, 1000); // up to ~12s

      if (init != null) coldInit.push(init);
      coldFirst.push(first);

      process.stdout.write(
        `Run ${i + 1} → init ~${init}ms, first ~${first}ms\n`
      );
      await sleep(1000);
    }

    // Warm run
    const warm = runArtillery(meta.url);

    results.push({
      framework: meta.framework,
      memory: meta.mem,
      cold_init_stats: summarize("init", coldInit),
      cold_first_stats: summarize("first", coldFirst),
      warm_summary: warm,
    });
  }

  fs.mkdirSync("reports", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = `reports/benchmark-${stamp}.json`;
  const mdPath = `reports/benchmark-${stamp}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  const md = [
    `# Lambda Benchmark (${stamp})`,
    "",
    "| Framework | Mem | Cold Init p95 (ms) | 1st Hit p95 (ms) | Warm p95 (ms) | Warm p99 (ms) | RPS | Errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...results.map(
      (r) =>
        `| ${r.framework} | ${r.memory} | ${r.cold_init_stats.p95 ?? ""} | ${
          r.cold_first_stats.p95 ?? ""
        } | ${r.warm_summary.p95 ?? ""} | ${r.warm_summary.p99 ?? ""} | ${
          r.warm_summary.rps ?? ""
        } | ${r.warm_summary.errors ?? ""} |`
    ),
    "",
    "## Notes",
    "- Cold start stats are computed from CloudWatch `Init Duration` and client-measured first response.",
    `- Warm stats from Artillery: duration=${WARM_DURATION}s, arrivalRate=${ARRIVAL_RATE}/s.`,
  ].join("\n");
  fs.writeFileSync(mdPath, md);

  console.log(`\n✅ Done.\nJSON: ${jsonPath}\nMD:   ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
