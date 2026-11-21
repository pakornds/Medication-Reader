// Browser-native editor. The public fields follow the RegimenComponent API shape.
const fields = [
  { key: "dose_amount", label: "Dose amount", type: "decimal", required: true },
  { key: "dose_unit", label: "Dose unit", required: true },
  {
    key: "schedule_type", label: "Schedule", required: true,
    options: [["frequency", "Frequency"], ["interval", "Interval"]],
  },
  { key: "frequency_count", label: "Times per period", type: "integer", required: true },
  { key: "period_value", label: "Period length", type: "decimal", required: true },
  {
    key: "period_unit", label: "Period unit", required: true,
    options: [["hour", "Hour"], ["day", "Day"], ["week", "Week"], ["month", "Month"]],
  },
  { key: "time_of_day", label: "Time of day", type: "times" },
  { key: "route", label: "Route", required: true },
  { key: "meal_relation", label: "Meal timing" },
  { key: "as_needed", label: "As needed", options: [["true", "Yes"], ["false", "No"]] },
];

const timePattern = /^(morning|noon|afternoon|evening|night|bedtime|([01]\d|2[0-3]):[0-5]\d)$/;

function element(tag, text) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}

function option(value, label) {
  const item = element("option", label);
  item.value = value;
  return item;
}

function timeValues(input) {
  return input
    .split(",")
    .map(part => part.trim().toLowerCase())
    .filter(Boolean);
}

function appendField(group, field, value, inputId) {
  const wrapper = element("div");
  const label = element("label", field.label);
  const input = element(field.options ? "select" : "input");
  input.id = inputId;
  input.name = field.key;
  input.required = Boolean(field.required);
  if (field.options) {
    input.append(option("", field.required ? "Select…" : "Unknown"));
    for (const [key, description] of field.options) {
      input.append(option(key, description));
    }
  } else if (field.type === "decimal" || field.type === "integer") {
    input.type = "number";
    input.step = field.type === "integer" ? "1" : "any";
    input.inputMode = field.type === "integer" ? "numeric" : "decimal";
  }
  input.value = Array.isArray(value) ? value.join(", ") : value ?? "";
  const error = element("span");
  error.id = `${input.id}-error`;
  error.className = "regimen-field-error";
  error.hidden = true;

  input.setAttribute("aria-describedby", error.id);
  if (field.type === "times") {
    const hint = element("span", "Use named times or 24-hour times, separated by commas.");
    hint.id = `${input.id}-hint`;
    hint.className = "regimen-guidance";
    input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
    label.append(input, hint, error);
  } else {
    label.append(input, error);
  }

  function validate(showError) {
    let message = "";
    if (input.required && input.value && !input.value.trim()) {
      message = "Enter a value.";
    }
    if (input.value && (field.type === "decimal" || field.type === "integer")) {
      if (input.valueAsNumber <= 0) message = "Enter a number greater than zero.";
    }
    if (field.type === "times" && timeValues(input.value).some(value => !timePattern.test(value))) {
      message = "Use a time such as evening or 18:00.";
    }
    input.setCustomValidity(message);
    const invalid = showError && !input.validity.valid;
    input.setAttribute("aria-invalid", String(invalid));
    error.textContent = invalid ? input.validationMessage : "";
    error.hidden = !invalid;
  }

  input.addEventListener("input", () => validate(false));
  input.addEventListener("blur", () => validate(true));
  input.addEventListener("invalid", () => validate(true));
  const sourceLabel = element("label", "Evidence source");
  sourceLabel.className = "regimen-field-source";
  sourceLabel.hidden = true;
  const sourceSelect = element("select");
  sourceSelect.setAttribute("aria-label", `Evidence source for ${field.label}`);
  sourceSelect.disabled = true;
  sourceLabel.append(sourceSelect);
  wrapper.append(label, sourceLabel);
  group.append(wrapper);
  return { input, wrapper, sourceLabel, sourceSelect };
}

function fieldValue(field, input) {
  if (field.type === "times") return timeValues(input.value);
  if (!input.value.trim() || input.disabled) return null;
  if (field.type === "integer" || field.type === "decimal") return input.valueAsNumber;
  if (field.key === "as_needed") return input.value === "true";
  return input.value.trim();
}

function describeRoute(route) {
  return route === "oral" ? "by mouth" : route;
}

export function summarizeRegimen(component) {
  const { dose_amount, dose_unit, schedule_type, frequency_count, period_value, period_unit } = component;
  const dose = dose_amount && dose_unit ? `${dose_amount} ${dose_unit}` : null;
  let schedule = null;
  if (period_value && period_unit) {
    const period = `${period_value} ${period_unit}${period_value === 1 ? "" : "s"}`;
    if (schedule_type === "interval") schedule = `every ${period}`;
    if (schedule_type === "frequency") {
      schedule = `${frequency_count} ${frequency_count === 1 ? "time" : "times"} per ${period}`;
    }
  }
  const asNeeded = component.as_needed === true ? "as needed" : null;
  return [
    dose,
    describeRoute(component.route),
    schedule,
    component.time_of_day.join(", "),
    component.meal_relation,
    asNeeded,
  ].filter(Boolean).join(" · ");
}

function refLabel(ref, sources) {
  const source = sources.find(item => item.id === ref.source_id);
  const name = source?.organization ?? source?.reporter ?? ref.source_id;
  return [name, source?.source_date, ref.item_id].filter(Boolean).join(" · ");
}

function sameValue(left, right) {
  return Array.isArray(left)
    ? Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index])
    : left === right;
}

function refKey(ref) {
  return JSON.stringify([ref.source_id, ref.item_id ?? null]);
}

function hasClaim(value) {
  return value != null && (!Array.isArray(value) || value.length > 0);
}

export function renderRegimenEvidence(root, components, sources) {
  const labels = { documented: "Label or record", reported: "Patient or caregiver report", verified: "Verified current use" };
  const cards = components.map(component => {
    const card = element("article");
    card.className = "regimen-evidence";
    const title = element("h3", labels[component.basis]);
    const quote = element("blockquote", component.directions_text);
    const citation = element("p", refLabel(component.evidence.directions_text, sources));
    citation.className = "regimen-citation";
    const details = element("details");
    details.append(element("summary", "Fields and sources"));
    const terms = element("dl");
    for (const field of fields) {
      const value = component[field.key];
      const source = component.evidence[field.key];
      if (source) {
        const displayed = Array.isArray(value) ? value.join(", ") : String(value);
        const item = element("dd");
        item.append(element("span", displayed), element("br"));
        const fieldCitation = element("small", refLabel(source, sources));
        fieldCitation.className = "regimen-citation";
        item.append(fieldCitation);
        terms.append(element("dt", field.label), item);
      }
    }
    if (component.unparsed_text) {
      terms.append(element("dt", "Unrepresented wording"), element("dd", component.unparsed_text));
      details.open = true;
    }
    details.append(terms);
    card.append(title, quote, citation, details);
    return card;
  });
  root.replaceChildren(...cards);
}

let editorCount = 0;

function createScheduleFields(group, component, inputPrefix, {
  observations, evidenceSources, verificationSource, verificationSourceLabel,
}) {
  const grid = element("div");
  grid.className = "regimen-fields";
  const controls = {};
  for (const field of fields) {
    controls[field.key] = appendField(grid, field, component[field.key], `${inputPrefix}-${field.key}`);
  }

  function updateSources() {
    const frequency = controls.schedule_type.input.value === "frequency";
    controls.frequency_count.input.disabled = !frequency;
    controls.frequency_count.wrapper.hidden = !frequency;
    for (const field of fields) {
      const control = controls[field.key];
      const value = fieldValue(field, control.input);
      const changed = hasClaim(value) && !sameValue(value, component[field.key]);
      control.sourceSelect.required = changed;
      control.sourceSelect.disabled = !changed;
      control.sourceLabel.hidden = !changed;
      if (!changed || sameValue(value, control.sourceValue)) continue;

      const matches = new Map();
      for (const observation of observations) {
        const reference = observation.evidence[field.key];
        if (reference && sameValue(value, observation[field.key])) {
          matches.set(refKey(reference), reference);
        }
      }
      const reviewerKey = refKey(verificationSource);
      const choices = [option("", "Select source")];
      for (const [key, reference] of matches) {
        if (key !== reviewerKey) choices.push(option(key, refLabel(reference, evidenceSources)));
      }
      choices.push(option(reviewerKey, verificationSourceLabel));
      control.sourceSelect.replaceChildren(...choices);
      control.sourceSelect.value = matches.size === 1 ? matches.keys().next().value : "";
      control.references = new Map([...matches, [reviewerKey, verificationSource]]);
      control.sourceValue = value;
    }
  }

  grid.addEventListener("input", updateSources);
  grid.addEventListener("change", updateSources);
  updateSources();
  group.append(grid);
  return controls;
}

function makeVerifiedComponent(original, controls, reference) {
  const edited = { ...original, basis: "verified", parse_status: "complete", unparsed_text: null };
  const evidence = { ...original.evidence };
  for (const field of fields) {
    const control = controls[field.key];
    const value = fieldValue(field, control.input);
    edited[field.key] = value;
    if (!hasClaim(value)) {
      delete evidence[field.key];
    } else if (!sameValue(value, original[field.key])) {
      evidence[field.key] = control.references.get(control.sourceSelect.value);
    }
  }
  edited.directions_text = summarizeRegimen(edited);
  if (original.basis !== "verified" || edited.directions_text !== original.directions_text) {
    evidence.directions_text = reference;
  }
  return { ...edited, evidence };
}

// The integration owns the medication row and supplies the clinician-record reference.
export function mountRegimenEditor(root, {
  components, observations = [], evidenceSources = [],
  verificationSource, verificationSourceLabel, onVerify, onChange = () => {},
}) {
  const form = element("form");
  const editorId = `regimen-${++editorCount}`;
  const pending = components.some(component => component.unparsed_text);
  const editors = components.map((component, index) => {
    const fieldset = element("fieldset");
    const title = components.length > 1 ? `Verify actual use · Schedule ${index + 1}` : "Verify actual use";
    fieldset.append(element("legend", title));
    const controls = createScheduleFields(fieldset, component, `${editorId}-${index}`, {
      observations, evidenceSources, verificationSource, verificationSourceLabel,
    });
    if (component.unparsed_text) {
      const unresolved = element("p", `Unrepresented wording: ${component.unparsed_text}`);
      unresolved.className = "regimen-guidance";
      fieldset.append(unresolved);
    }
    return { fieldset, controls, component };
  });

  const guidance = element("p", pending
    ? "Keep this row pending until evidence provides a complete regimen."
    : `Verification recorded by ${verificationSourceLabel}.`);
  guidance.className = "regimen-guidance";
  const button = element("button", "Verify actual use");
  button.type = "submit";
  button.className = "regimen-button";
  button.id = `${editorId}-submit`;
  button.disabled = pending;
  const error = element("p");
  error.className = "regimen-status";
  error.setAttribute("role", "alert");

  root.classList.add("regimen-editor");
  form.append(...editors.map(({ fieldset }) => fieldset), guidance, error, button);
  form.addEventListener("input", () => {
    error.textContent = "";
    onChange();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (pending) return;
    const edited = editors.map(({ controls, component }) =>
      makeVerifiedComponent(component, controls, verificationSource));
    try {
      error.textContent = "";
      button.disabled = true;
      await onVerify(edited);
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : "Verification failed.";
    } finally {
      button.disabled = false;
    }
  });
  root.replaceChildren(form);
  return {
    submitButton: button,
    setDisabled(disabled) {
      for (const { fieldset } of editors) fieldset.disabled = disabled;
      button.disabled = disabled || pending;
    },
  };
}
