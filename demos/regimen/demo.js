import {
  mountRegimenEditor,
  renderRegimenEvidence,
  summarizeRegimen,
} from "/regimen-review/regimen-editor.js";

const rowId = "row-a";
const labelRef = { source_id: "label-photo", item_id: "label-a" };
const patientRef = { source_id: "patient-account" };
const verificationRef = { source_id: "reviewer-record" };
const labelText = "Take 1 tablet by mouth every morning";
const patientText = "I take 1 tablet by mouth every evening";
const demoReviewer = { id: "demo-pharmacist", name: "Demo pharmacist", role: "pharmacist" };

const loadButton = document.querySelector("#load-case");
const casePanel = document.querySelector("#case-review");
const status = document.querySelector("#demo-status");
const error = document.querySelector("#demo-error");
const reviewStatus = document.querySelector("#review-status");
const importPanel = document.querySelector("#import-panel");
const importButton = document.querySelector("#approve-import");
const receiptPanel = document.querySelector("#receipt");
const sourcePanel = document.querySelector("#regimen-sources");
const verifiedSummary = document.querySelector("#verified-summary");

let draft;
let editor;

function errorContent(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map(item => item.msg).filter(Boolean).join(" ");
  return detail?.message;
}

async function api(path, payload) {
  const options = payload === undefined ? {} : {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
  const response = await fetch(path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(errorContent(result.detail) ?? `Request failed (${response.status}).`);
  return result;
}

function showError(message) {
  error.textContent = message;
  error.hidden = !message;
}

function fixtureEvidence() {
  return {
    case_id: `demo-regimen-${crypto.randomUUID()}`,
    sources: [
      { id: labelRef.source_id, kind: "label_photo", organization: "Demo clinic", source_date: "2026-11-21" },
      { id: patientRef.source_id, kind: "patient_report", reporter: "Demo patient", source_date: "2026-11-21" },
      { id: verificationRef.source_id, kind: "reviewer_record", reporter: demoReviewer.name, source_date: "2026-11-21" },
    ],
    items: [{ id: labelRef.item_id, source_id: labelRef.source_id, row_id: rowId, kind: "label_region" }],
  };
}

function parse(evidence, { basis, componentId, text, source }) {
  return api("/regimens/parse", {
    evidence,
    row_id: rowId,
    component_id: componentId,
    basis,
    directions_text: text,
    source,
  });
}

function makeRow(observations) {
  return {
    id: rowId,
    identity_status: "named",
    sources: [labelRef, patientRef],
    observed_names: [{ value: "Demo A", evidence: labelRef }],
    dispensing_source_id: labelRef.source_id,
    label_fields: {
      strength: { status: "readable", value: "5 mg", evidence: labelRef },
      form: { status: "readable", value: "tablet", evidence: labelRef },
      directions: { status: "readable", value: labelText, evidence: labelRef },
    },
    reported_use: [{ value: patientText, evidence: patientRef }],
    discrepancies: [{
      id: "timing-differs",
      field: "directions",
      observed_values: [
        { value: labelText, evidence: labelRef },
        { value: patientText, evidence: patientRef },
      ],
      question: "When does the patient actually take Demo A?",
    }],
    regimens: observations,
  };
}

function clearVerification() {
  if (!draft.verifiedRow) return;
  draft.verifiedRow = null;
  draft.approval = null;
  draft.receipt = null;
  draft.retryToken = null;
  reviewStatus.textContent = "Edited · verify again";
  delete reviewStatus.dataset.complete;
  receiptPanel.replaceChildren();
  importPanel.hidden = true;
}

function saveVerification(components) {
  showError("");
  receiptPanel.replaceChildren();
  draft.revision += 1;
  draft.approval = null;
  draft.receipt = null;
  draft.retryToken = crypto.randomUUID();
  draft.verifiedRow = {
    ...draft.originalRow,
    revision: draft.revision,
    verification: {
      reviewer: demoReviewer,
      verified_at: new Date().toISOString(),
      status: "current",
      identity: draft.originalRow.observed_names[0],
      normalized_medication_id: "demo-a",
      regimens: components,
      evidence: [verificationRef, patientRef],
      resolved_discrepancies: ["timing-differs"],
    },
  };
  reviewStatus.textContent = "Current use verified";
  reviewStatus.dataset.complete = "true";
  verifiedSummary.textContent = components.map(summarizeRegimen).join(" · ");
  importPanel.hidden = false;
  importButton.disabled = false;
  importButton.textContent = "Approve and import selected row";
  importButton.focus();
}

async function loadCase() {
  status.textContent = "Parsing label and patient report…";
  showError("");
  loadButton.disabled = true;
  try {
    const evidence = fixtureEvidence();
    const [documented, reported] = await Promise.all([
      parse(evidence, { basis: "documented", componentId: "label-directions", text: labelText, source: labelRef }),
      parse(evidence, { basis: "reported", componentId: "reported-directions", text: patientText, source: patientRef }),
    ]);
    const observations = [...documented.regimens, ...reported.regimens];
    draft = { evidence, originalRow: makeRow(observations), revision: 1 };
    renderRegimenEvidence(sourcePanel, observations, evidence.sources);
    editor = mountRegimenEditor(document.querySelector("#regimen-editor"), {
      components: documented.regimens,
      observations,
      evidenceSources: evidence.sources,
      verificationSource: verificationRef,
      verificationSourceLabel: demoReviewer.name,
      onVerify: saveVerification,
      onChange: clearVerification,
    });
    editor.submitButton.id = "verify-regimen";
    reviewStatus.textContent = "Timing differs between sources";
    delete reviewStatus.dataset.complete;
    importPanel.hidden = true;
    receiptPanel.replaceChildren();
    casePanel.hidden = false;
    status.textContent = "Review the reported timing and update the schedule before verifying.";
    loadButton.textContent = "Start another demo case";
    document.querySelector("#review-heading").tabIndex = -1;
    document.querySelector("#review-heading").focus();
  } catch (failure) {
    status.textContent = "";
    showError(failure.message);
  } finally {
    loadButton.disabled = false;
  }
}

function renderReceipt(receipt, verified) {
  const heading = document.createElement("strong");
  heading.textContent = "Mock hospital import accepted";
  const timestamp = document.createElement("p");
  timestamp.textContent = `Receipt (UTC) ${receipt.imported_at}`;
  const summary = document.createElement("p");
  summary.textContent = verified
    ? `Stored verified regimen: ${verified.regimens.map(summarizeRegimen).join(" · ")}`
    : "The receiving record has not been retrieved yet.";
  receiptPanel.replaceChildren(heading, timestamp, summary);
}

async function approveImport() {
  if (!draft.verifiedRow) return;
  showError("");
  loadButton.disabled = true;
  importButton.disabled = true;
  editor.setDisabled(true);
  const row = draft.verifiedRow;

  try {
    if (!draft.receipt) {
      if (!draft.approval) {
        draft.approval = await api("/imports/approvals", { evidence: draft.evidence, row });
      }
      draft.receipt = await api("/imports", {
        evidence: draft.evidence,
        retry_token: draft.retryToken,
        selected_row_ids: [row.id],
        rows: [{ ...row, approval: draft.approval }],
      });
    }

    const receipt = draft.receipt;
    renderReceipt(receipt);
    const query = new URLSearchParams({ imported_at: receipt.imported_at });
    const records = await api(`/imports?${query}`);
    const record = records.find(item => item.snapshot.evidence.case_id === draft.evidence.case_id);
    const stored = record?.snapshot.rows.find(item => item.id === row.id && item.revision === row.revision);
    if (!stored?.verification?.regimens.length) throw new Error("No verified regimen was returned for this revision.");
    renderReceipt(receipt, stored.verification);
    importButton.textContent = "Imported";
    status.textContent = "The receiving record returned the verified regimen.";
  } catch (failure) {
    showError(failure.message);
    importButton.textContent = draft.receipt ? "Retry receipt lookup" : "Retry import";
    importButton.disabled = false;
  } finally {
    editor.setDisabled(false);
    loadButton.disabled = false;
  }
}

loadButton.addEventListener("click", loadCase);
importButton.addEventListener("click", approveImport);
