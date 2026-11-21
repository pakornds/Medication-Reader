import { mountLocalScreening } from "./local-screening.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function exercise() {
  const root = document.querySelector("#test-root");
  const find = selector => root.querySelector(selector);
  const payloads = [];
  let delayedResponse;
  globalThis.fetch = async (url, options) => {
    if (url.startsWith("/checks/local/products?")) {
      return Response.json({ products: [{ tpu: "123", label: "Fixture product" }], tmt_release: "test" });
    }
    expect(url === "/checks/local", "unexpected request");
    payloads.push(JSON.parse(options.body));
    return new Promise(resolve => { delayedResponse = resolve; });
  };
  mountLocalScreening(root);
  find("#catalogue-query").value = "123";
  find("#catalogue-search").requestSubmit();
  for (let i = 0; i < 50 && !find("#catalogue-results button"); i++) await tick();
  expect(find("#catalogue-results button"), `search failed: ${find("#catalogue-status").textContent}`);
  find("#catalogue-results button").click();
  find("#add-unknown").click();
  const form = find(".local-verify");
  form.requestSubmit();
  find("#run-local").click();
  expect(payloads[0].rows.every(row => !row.verification), "selection verified a medicine");
  const sourceFields = {
    identity_text: "Fixture tablet", identity_source: "transfer_record",
    use_text: "Currently used", use_source: "patient_report", use_status: "current",
    reviewer_role: "pharmacist",
  };
  for (const [key, value] of Object.entries(sourceFields)) {
    form.elements[key].value = value;
    form.elements[key].dispatchEvent(new Event("input", { bubbles: true }));
  }
  form.requestSubmit();
  delayedResponse(Response.json({}));
  await tick();
  expect(!find("#local-report").textContent, "late response rendered after verification changed");
  find("#run-local").click();
  expect(payloads[1].rows[0].verification?.normalized_medication_id === "123", "verified row omitted");
  expect(!payloads[1].rows[1].verification, "unknown row incorrectly verified");
  form.elements.use_text.value = "Different source statement";
  form.elements.use_text.dispatchEvent(new Event("input", { bubbles: true }));
  delayedResponse(Response.json({}));
  await tick();
  expect(find(".row-status").textContent.includes("verify"), "edited row still appears verified");
  expect(!find("#local-report").textContent, "late response rendered after a source change");
  expect(!find("#local-status").textContent.includes("error"), "stale response touched status");
  find("#run-local").click();
  expect(!payloads[2].rows[0].verification, "stale verification submitted");
}

try {
  await exercise();
  document.querySelector("#out").textContent = "PASS";
} catch (error) {
  document.querySelector("#out").textContent = error.message;
}
