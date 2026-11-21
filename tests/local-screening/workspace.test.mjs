import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { pendingRecord, verifiedRecord } from "../../src/components/review/local-screening.js";

const product = { tpu: "fixture-123", label: "Fixture tablet", tmt_release: "fixture-release" };

test("catalogue selection remains pending until a reviewer attributes identity and use", () => {
  const pending = pendingRecord("one", product, 1);
  assert.equal(pending.row.verification, undefined);
  assert.equal(pending.row.observed_names, undefined);
  const record = verifiedRecord("one", product, 2, {
    identity_source: "prescription", identity_text: "Fixture tablet on sheet",
    use_source: "caregiver_report", use_text: "Use stopped", use_status: "no_longer_current",
    reviewer_role: "doctor",
  }, "reviewer");
  assert.equal(record.row.verification.status, "no_longer_current");
  assert.equal(record.row.verification.tmt_release, "fixture-release");
  assert.equal(record.row.verification.identity.value, product.label);
  assert.equal(record.row.observed_names[0].value, "Fixture tablet on sheet");
  assert.equal(record.row.reported_use[0].value, "Use stopped");
  assert.notDeepEqual(record.row.verification.identity.evidence, record.row.reported_use[0].evidence);
  assert.deepEqual(record.sources.map(source => source.kind), ["prescription", "caregiver_report"]);
  assert.ok(record.items.every(item => item.row_id === "one"));
});

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser",
].find(path => path && existsSync(path));

test("editing a row suppresses a pending response and invalidates verification in the browser", {
  skip: chrome ? false : "Set CHROME_BIN to exercise the browser regression.",
}, async () => {
  const components = new URL("../../src/components/review/", import.meta.url);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://local").pathname;
      if (pathname === "/") {
        response.setHeader("content-type", "text/html");
        response.end('<div id="test-root"></div><output id="out">WAIT</output><script type="module" src="/run.js"></script>');
      } else if (pathname === "/run.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(await readFile(new URL("./browser-case.mjs", import.meta.url)));
      } else if (["local-screening.js", "local-screening-template.js"].includes(basename(pathname))) {
        response.setHeader("content-type", "text/javascript");
        response.end(await readFile(new URL(basename(pathname), components)));
      } else {
        response.writeHead(404).end();
      }
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const profile = await mkdtemp(join(tmpdir(), "medication-review-test-"));
  try {
    const { stdout } = await promisify(execFile)(chrome, [
      "--headless", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`,
      "--virtual-time-budget=5000", "--dump-dom", `http://127.0.0.1:${server.address().port}/`,
    ], { timeout: 20000, maxBuffer: 2 ** 20 });
    const outcome = stdout.match(/<output id="out">([^<]*)<\/output>/)?.[1];
    assert.equal(outcome, "PASS");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
