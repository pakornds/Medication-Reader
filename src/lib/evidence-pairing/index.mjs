const photoKinds = new Set(["label_photo", "reverse_photo", "additional_photo"]);

const matchQuestions = {
  ambiguous: "Match this item to a reverse-side crop or retake the photo.",
  hidden: "Retake the photo with the reverse side of this item visible.",
  replaced: "Confirm a crop for this item using the current photos.",
};

const sameRef = (left, right) =>
  left != null && right != null && left.source_id === right.source_id && left.item_id === right.item_id;

function getRow(draft, rowId) {
  const row = draft.rows.find(candidate => candidate.id === rowId);
  if (!row) throw new Error(`Unknown medication row: ${rowId}`);
  return row;
}

function getCurrentRow(draft, rowId, revision) {
  const row = getRow(draft, rowId);
  if (row.revision !== revision) throw new Error("Photo match review is stale");
  return row;
}

function withPhotoMatch(row, crop, question) {
  const followUps = (row.follow_ups ?? []).filter(item => item.field !== "photo_match");
  if (question) followUps.push({ field: "photo_match", question });
  return {
    ...row,
    reverse_crop: crop,
    sources: crop && !row.sources.some(ref => sameRef(ref, crop)) ? [...row.sources, crop] : row.sources,
    follow_ups: followUps,
    revision: row.revision + 1,
    approval: null,
  };
}

function withoutEvidence(row, removed) {
  const keep = ref => !removed(ref);
  const keepObservation = observation => keep(observation.evidence);
  const keepRegimen = component => Object.values(component.evidence ?? {}).every(keep);
  const updated = {
    ...row,
    sources: row.sources.filter(keep),
    observed_names: (row.observed_names ?? []).filter(keepObservation),
    label_fields: Object.fromEntries(Object.entries(row.label_fields ?? {})
      .filter(([, observation]) => keepObservation(observation))),
    reported_use: (row.reported_use ?? []).filter(keepObservation),
    regimens: (row.regimens ?? []).filter(keepRegimen),
    discrepancies: (row.discrepancies ?? []).filter(item => item.observed_values.every(keepObservation)),
    follow_ups: (row.follow_ups ?? []).filter(item => keep({ source_id: item.potential_source_id })),
  };

  if (removed({ source_id: row.dispensing_source_id })) updated.dispensing_source_id = null;
  const verification = row.verification;
  if (verification && (
    !verification.evidence.every(keep) ||
    ![verification.identity, verification.dose, verification.route, verification.frequency]
      .every(field => !field || keepObservation(field)) ||
    !(verification.regimens ?? []).every(keepRegimen) ||
    updated.discrepancies.length !== (row.discrepancies ?? []).length
  )) {
    updated.verification = null;
  }
  // The visible row ID survives a retake, even while it awaits new label evidence.
  if (row.identity_status === "named" && updated.observed_names.length === 0) {
    updated.identity_status = "unreadable";
    updated.unknown_label = row.unknown_label ?? "Unknown medication";
  }
  return updated;
}

function sameItem(item, ref) {
  return item.source_id === ref.source_id && item.id === ref.item_id;
}

function updateMatch(draft, row, crop, question) {
  const previous = row.reverse_crop;
  const items = (draft.evidence.items ?? []).filter(item => !previous || !sameItem(item, previous));
  if (crop && !items.some(item => sameItem(item, crop))) {
    items.push({ id: crop.item_id, source_id: crop.source_id, row_id: row.id, kind: "pill_crop" });
  }
  const updated = previous ? withoutEvidence(row, ref => sameRef(ref, previous)) : row;
  return {
    ...draft,
    evidence: { ...draft.evidence, items },
    rows: draft.rows.map(candidate => candidate === row ? withPhotoMatch(updated, crop, question) : candidate),
  };
}

/** Record an intake observation without assigning a crop by item order or position. */
export function flagPhotoMatch(draft, { rowId, revision, reason }) {
  if (reason !== "ambiguous" && reason !== "hidden") throw new Error("Unknown photo match reason");
  return updateMatch(draft, getCurrentRow(draft, rowId, revision), null, matchQuestions[reason]);
}

/** Confirm a staff-selected crop registered by intake in draft.reverseCropCandidates. */
export function confirmReverseCrop(draft, { rowId, revision, crop }) {
  const row = getCurrentRow(draft, rowId, revision);
  const source = draft.evidence.sources.find(candidate => candidate.id === crop.source_id);
  if (!crop.item_id?.trim() || source?.kind !== "reverse_photo" || source.availability === "unavailable") {
    throw new Error("Choose a crop from a current reverse-side photo");
  }

  const item = (draft.evidence.items ?? []).find(candidate => sameItem(candidate, crop));
  if (item && (item.kind !== "pill_crop" || item.row_id !== rowId)) {
    throw new Error("This evidence item is already assigned");
  }
  if (!item && !(draft.reverseCropCandidates ?? []).some(candidate => sameRef(candidate, crop))) {
    throw new Error("This crop was not located in the current photo");
  }

  const ref = { source_id: crop.source_id, item_id: crop.item_id };
  if (sameRef(row.reverse_crop, ref)) return draft;
  return updateMatch(draft, row, ref);
}

/**
 * Replace the whole upload, including logical photo sources that share its attachment ID.
 * Photo-only rows can remain source-less in the intake draft until evidence is reassigned.
 */
export function replacePhoto(draft, { sourceId, replacement }) {
  const photo = draft.evidence.sources.find(source => source.id === sourceId);
  if (!photoKinds.has(photo?.kind)) throw new Error("Choose an existing photo to replace");
  const retiredIds = new Set(draft.retiredPhotoSourceIds);
  const retiredAttachments = new Set(draft.retiredPhotoAttachmentIds);
  if (replacement.kind !== photo.kind || replacement.availability === "unavailable" ||
      !replacement.id?.trim() || retiredIds.has(replacement.id) ||
      draft.evidence.sources.some(source => source.id === replacement.id) ||
      (replacement.attachment_id && (retiredAttachments.has(replacement.attachment_id) ||
        draft.evidence.sources.some(source => source.attachment_id === replacement.attachment_id)))) {
    throw new Error("A retake needs a fresh source and attachment ID for the same photo view");
  }

  const removedIds = new Set(draft.evidence.sources.filter(source =>
    source.id === sourceId || (photo.attachment_id && source.attachment_id === photo.attachment_id &&
      photoKinds.has(source.kind))).map(source => source.id));
  const isReplaced = ref => removedIds.has(ref?.source_id);
  const labelSourceIds = new Set(draft.evidence.sources.filter(source =>
    source.kind === "label_photo" && removedIds.has(source.id)).map(source => source.id));
  const items = draft.evidence.items ?? [];
  const removedItems = items.filter(item => removedIds.has(item.source_id));
  const affectedRows = new Set(removedItems.map(item => item.row_id));
  const discardedCrops = [];
  const rows = draft.rows.map(row => {
    if (!affectedRows.has(row.id) && !row.sources.some(isReplaced) && !isReplaced(row.reverse_crop)) {
      return row;
    }
    const replacedLabel = row.sources.some(ref => labelSourceIds.has(ref.source_id));
    if (row.reverse_crop && !replacedLabel && !isReplaced(row.reverse_crop)) {
      return { ...withoutEvidence(row, isReplaced), revision: row.revision + 1, approval: null };
    }
    const crop = row.reverse_crop;
    if (crop) discardedCrops.push(crop);
    const updated = withoutEvidence(row, ref => isReplaced(ref) || sameRef(ref, crop));
    return withPhotoMatch(updated, null, matchQuestions.replaced);
  });

  for (const id of removedIds) retiredIds.add(id);
  if (photo.attachment_id) retiredAttachments.add(photo.attachment_id);
  return {
    ...draft,
    evidence: {
      ...draft.evidence,
      sources: [...draft.evidence.sources.filter(source => !removedIds.has(source.id)), replacement],
      items: items.filter(item => !removedIds.has(item.source_id) &&
        !discardedCrops.some(ref => sameItem(item, ref))),
    },
    rows,
    reverseCropCandidates: (draft.reverseCropCandidates ?? []).filter(ref => !isReplaced(ref)),
    retiredPhotoSourceIds: [...retiredIds],
    retiredPhotoAttachmentIds: [...retiredAttachments],
  };
}
