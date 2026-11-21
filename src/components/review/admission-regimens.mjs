import { regimenStatement } from "./admission-review.mjs";
import { mountRegimenEditor, renderRegimenEvidence } from "./regimen-editor.js";

export function verifiedRegimenSummary(verification, sources, escape) {
  if (!verification.regimens?.length) {
    const { dose, route, schedule } = verification.answer;
    return "<br>Verified regimen · " + escape([dose, route, schedule].filter(Boolean).join(" · "));
  }
  const details = document.createElement("div");
  renderRegimenEvidence(details, verification.regimens, sources);
  return "</p>" + details.innerHTML + "<p>";
}

export function regimenStatements(review) {
  const reports = review.accounts.filter(entry => ["patient_report", "caregiver_report"].includes(entry.source.kind));
  return [
    ...review.documentedSources.map(entry => [entry, "documented"]),
    ...reports.map(entry => [entry, "reported"]),
  ].map(([entry, basis]) => regimenStatement(review.caseId, review.rowId, entry, basis));
}

export function regimenEvidenceChoices(entries) {
  return entries.filter(entry => entry.source.availability !== "unavailable" &&
    (!entry.photo || (!entry.photo.appearance && (entry.photo.front_attributed || entry.photo.pairing === "matched"))));
}

export function openRegimenVerification({ form, review, entries, actor, verify, parse }) {
  const statements = regimenStatements(review);
  const prior = review.verified?.regimens || [];
  if (!statements.length && !prior.length) return;
  const choice = document.createElement("select");
  choice.setAttribute("aria-label", "Regimen to verify");
  if (prior.length) choice.add(new Option("Previously verified components", "verified"));
  else choice.add(new Option("Interview dose, route and schedule", ""));
  statements.forEach((statement, index) => {
    const label = statement.basis === "reported" ? "Patient or caregiver report" : "Documented directions";
    const source = statement.evidence.sources[0];
    choice.add(new Option([label, source.organization || source.reporter || source.id, statement.directions_text].join(" · "), String(index)));
  });
  const label = document.createElement("label");
  label.append("Regimen to verify", choice);
  const evidence = document.createElement("select");
  evidence.add(new Option("Select the source supporting the verified wording", ""));
  const available = regimenEvidenceChoices(entries);
  for (const { source, wording } of available) {
    evidence.add(new Option([source.organization || source.reporter || source.id, wording].join(" · "), source.id));
  }
  if (prior.length) evidence.value = prior[0].evidence.directions_text.source_id;
  const evidenceLabel = document.createElement("label");
  evidenceLabel.append("Evidence for verified directions", evidence);
  form.querySelector("#fields").append(label, evidenceLabel);
  const dialog = form.closest("dialog");
  const submit = form.querySelector('[type="submit"]');
  // The shared editor supplies a native form and must be a sibling of the admission form.
  const panel = document.createElement("section");
  dialog.append(panel);
  dialog.addEventListener("close", () => { panel.remove(); submit.hidden = false; }, { once: true });
  let generation = 0;
  async function show() {
    const current = ++generation;
    panel.replaceChildren();
    submit.hidden = choice.value !== "";
    evidenceLabel.hidden = !submit.hidden;
    if (!submit.hidden) return;
    if (!evidence.value) {
      panel.textContent = "Select the evidence supporting actual use. Use Link source or photo to record new clinician evidence.";
      return;
    }
    panel.textContent = "Loading source-linked regimen…";
    try {
      const results = await Promise.allSettled(statements.map(parse));
      if (!panel.isConnected || current !== generation) return;
      const selected = results[Number(choice.value)];
      if (choice.value !== "verified" && selected.status === "rejected") throw selected.reason;
      const components = choice.value === "verified" ? prior : selected.value.regimens;
      const observations = results.flatMap(result => result.status === "fulfilled" ? result.value.regimens : []);
      mountRegimenEditor(panel, {
        components, observations, evidenceSources: available.map(entry => entry.source),
        verificationSource: { source_id: evidence.value, item_id: review.rowId },
        verificationSourceLabel: actor.name + " citing " + evidence.selectedOptions[0].textContent,
        async onVerify(edited) {
          if (!form.reportValidity()) return;
          evidence.disabled = choice.disabled = true;
          try {
            await verify(edited);
            dialog.close();
          } finally {
            evidence.disabled = choice.disabled = false;
          }
        },
      });
    } catch (error) {
      if (panel.isConnected && current === generation) panel.textContent = error.message;
    }
  }
  choice.addEventListener("change", show);
  evidence.addEventListener("change", show);
  show();
  return { editing: () => choice.value !== "" };
}
