export function renderUnavailableSources(root, encounter) {
  const records = Object.values(encounter.unavailable_sources ?? {});
  if (!records.length) return;

  const section = document.createElement("section");
  section.setAttribute("aria-label", "Unavailable sources");
  const heading = document.createElement("h3");
  heading.textContent = "Unavailable sources";
  section.append(heading);
  for (const { source, follow_up } of records) {
    const article = document.createElement("article");
    const record = document.createElement("strong");
    record.textContent = [
      source.kind.replaceAll("_", " "), source.organization, source.department_or_ward,
      source.reporter, source.source_date,
    ].filter(Boolean).join(" · ");
    article.append(record);
    const recorded = encounter.events.find(event =>
      event.action === "record_unavailable_source" && event.sources.includes(source.id)
    );
    const details = [
      ["Reason", source.unavailable_reason],
      ["Follow-up", follow_up],
      ["Contact", source.contact],
      ["Recorded by", recorded && [recorded.actor.name, recorded.actor.role, new Date(recorded.at).toLocaleString()].join(" · ")],
    ];
    for (const [label, value] of details) {
      if (!value) continue;
      const line = document.createElement("p");
      line.textContent = label + " · " + value;
      article.append(line);
    }
    section.append(article);
  }
  root.append(section);
}
