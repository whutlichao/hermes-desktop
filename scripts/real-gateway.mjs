#!/usr/bin/env node
import { runRealGateway } from "./real-gateway-core.mjs";

const result = await runRealGateway(process.argv.slice(2));
process.stdout.write(result.summaryMd);
console.log(
  `[real-gateway] status=${result.report.status} typedCode=${result.report.typedCode ?? "none"} exitCode=${result.exitCode}`,
);
process.exitCode = result.exitCode;
