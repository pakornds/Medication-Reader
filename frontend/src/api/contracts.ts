// Generated from FastAPI and its multipart models by tests/api/generate_contracts.py.

export type Action = {
  revision: number
  request_id: string
  command: AddRow | AddEvidence | Interview | Verify | Proposal | Decision | Refer | Finish | Import
}

export type AddEvidence = {
  action: "link"
  row_id: string
  entry: SourceEntry
  confirmed: true
  replaces?: string | null
}

export type AddRow = {
  action: "add"
  entry: SourceEntry
}

export type AnalysisPreview = {
  case_id: string
  rows: Array<MedicationSuggestion>
  dispensing_facilities?: Partial<Record<string, DispensingFacility>>
  unavailable_sources?: Array<EvidenceSource>
  unassigned_reports?: Array<SourcedValue>
}

export type AnalysisResult = {
  case_id: string
  rows: Array<MedicationSuggestion>
}

export type ApprovalRequest = {
  evidence: CaseEvidence
  row: ReviewRow
}

export type ApprovedSnapshot = {
  evidence: CaseEvidence
  rows: Array<ReviewRow>
}

export type CandidateRequest = {
  evidence: CaseEvidence
  observation: PillObservation
}

export type CandidateResult = {
  row_id: string
  status?: "unresolved"
  candidates?: Array<PillCandidate>
  follow_up: string
}

export type CaptureCommand = {
  revision: number
  request_id: string
  manifest: PackageCapture
  existing_rows?: Partial<Record<string, string>>
}

export type CaptureViewRequest = {
  side: "front" | "reverse"
  attachment_id: string
  revision: number
}

export type CaseEvidence = {
  case_id: string
  sources: Array<EvidenceSource>
  items?: Array<EvidenceItem>
}

export type CheckExclusion = {
  scope: CheckedScope
  reason: string
}

export type CheckFinding = {
  scope: CheckedScope
  source: ReferenceVersion
  description: string
}

export type CheckSummary = {
  kind: "DDI" | "DRP"
  status: "not_run" | "unavailable" | "partial" | "complete"
  simulated?: true
  ran_at?: string | null
  source?: ReferenceVersion | null
  evaluated?: Array<CheckedScope>
  excluded?: Array<CheckExclusion>
  findings?: Array<CheckFinding>
}

export type CheckedScope = {
  row_ids: Array<string>
  rule_id?: string | null
}

export type CoverageRequest = {
  kind: "DDI" | "DRP"
  enabled: boolean
  rows: Array<ReviewRow>
  context?: Record<string, string | number | number | boolean>
  evidence: CaseEvidence
}

export type CurrentUseVerification = {
  reviewer: ReviewerIdentity
  verified_at: string
  status: "current" | "no_longer_current" | "uncertain"
  identity?: SourcedValue | null
  normalized_medication_id?: string | null
  tmt_release?: string | null
  dose?: SourcedValue | null
  route?: SourcedValue | null
  frequency?: SourcedValue | null
  regimens?: Array<RegimenComponent>
  evidence: Array<EvidenceRef>
  resolved_discrepancies?: Array<string>
  identity_resolutions?: Array<IdentityResolutionEvidence>
}

export type DDILookup = {
  status: "potential" | "lookup_complete" | "partial" | "unassessed"
  reasons: Array<string>
  interactions?: Array<RuleMatch>
}

export type Decision = {
  action: "decide"
  row_id: string
  outcome: "confirm" | "correct" | "reject" | "pending"
  source_id: string
  finding: string
  name?: string | null
}

export type Discrepancy = {
  id: string
  field: LabelField | "identity" | "reported_use"
  observed_values: Array<SourcedValue>
  question: string
}

export type DispensingFacility = {
  evidence: EvidenceRef
  organization: string
  organization_type?: "clinic" | "hospital" | "community_pharmacy" | "other" | null
  department_or_ward?: string | null
  organization_address?: string | null
  organization_phone?: string | null
  organization_phone_extension?: string | null
  organization_email?: string | null
}

export type DuplicateLookup = {
  status: "potential" | "lookup_complete" | "unassessed"
  reasons: Array<string>
  ingredients?: Array<Ingredient>
}

export type EvidenceItem = {
  id: string
  source_id: string
  row_id: string
  kind: "label_region" | "matched_reverse_label" | "pill_crop" | "record_excerpt"
}

export type EvidenceRef = {
  source_id: string
  item_id?: string | null
}

export type EvidenceSource = {
  id: string
  kind: SourceKind
  attachment_id?: string | null
  organization?: string | null
  organization_type?: "clinic" | "hospital" | "community_pharmacy" | "other" | null
  organization_address?: string | null
  organization_phone?: string | null
  organization_phone_extension?: string | null
  organization_email?: string | null
  department_or_ward?: string | null
  reporter?: string | null
  collector?: string | null
  contact?: string | null
  source_date?: string | null
  availability?: "available" | "unavailable"
  unavailable_reason?: string | null
}

export type ExposureObservation = {
  row_ids: Array<string>
  status: "unknown" | "excluded" | "confirmed"
  evidence_ids?: Array<string>
  observed_at?: string | null
}

export type Finish = {
  action: "finish"
}

export type FollowUp = {
  question: string
  field: LabelField | "identity" | "reported_use" | "source" | "photo_match"
  potential_source_id?: string | null
}

export type FormAnalysisInput = {
  evidence: CaseEvidence
  patient_report?: Array<SourcedValue>
  other_source_notes?: Array<SourcedValue>
  question?: string | null
  photo_source_ids?: Array<string>
  region_locations?: Partial<Record<string, Partial<Record<string, string>>>>
  patient_report_row_ids?: Partial<Record<string, string>>
}

export type HTTPValidationError = {
  detail?: Array<ValidationError>
}

export type HospitalRecord = {
  snapshot: ApprovedSnapshot
  receipt: ImportReceipt
}

export type IdentityResolutionEvidence = {
  discrepancy_id: string
  evidence: EvidenceRef
  documented_name: string
  identity_basis: "matched_original_package" | "dispensing_confirmation" | "item_specific_record"
  finding: string
}

export type Import = {
  action: "import"
  row_ids: Array<string>
}

export type ImportReceipt = {
  imported_at: string
  imported_row_ids: Array<string>
}

export type ImportRequest = {
  evidence: CaseEvidence
  retry_token: string
  selected_row_ids: Array<string>
  rows: Array<ReviewRow>
}

export type Ingredient = {
  subs_id: string
  name: string
}

export type Interview = {
  action: "interview"
  row_id: string
  source_id: string
  ownership_source_id?: string | null
  ownership: "patient" | "other" | "uncertain"
  current_use: "current" | "reported_stopped" | "discontinued_order" | "not_owned" | "uncertain"
  dose?: string | null
  route?: string | null
  schedule?: string | null
  reason?: string | null
  note?: string | null
}

export type LabelField = "dose" | "indication" | "directions" | "amount_prescribed" | "prescriber" | "prescriber_contact" | "strength" | "form" | "expiry"

export type LabelPhotoRequest = {
  evidence: CaseEvidence
  source_id: string
  media_type: "image/png" | "image/jpeg" | "image/webp"
  image_base64: string
  region_locations?: Partial<Record<string, string>>
}

export type LocalScreeningRequest = {
  evidence: CaseEvidence
  rows: Array<ReviewRow>
}

export type LocalScreeningResult = {
  snapshot_id: string
  tmt_release: string
  fest_release: string | null
  ddi_unavailable_reason: string | null
  ddi_scope: string
  mapping_version: string
  checked_at: string
  rows: Array<ScreenedRow>
  pairs: Array<ScreenedPair>
}

export type MedicationSuggestion = {
  id: string
  identity_status: "named" | "unlabeled" | "unreadable"
  unknown_label?: string | null
  sources: Array<EvidenceRef>
  dispensing_source_id?: string | null
  observed_names?: Array<SourcedValue>
  label_fields?: Partial<Record<LabelField, Observation>>
  reported_use?: Array<SourcedValue>
  regimens?: Array<RegimenComponent>
  reverse_crop?: EvidenceRef | null
  discrepancies?: Array<Discrepancy>
  follow_ups?: Array<FollowUp>
}

export type NewEncounter = {
  patient_alias: string
  assigned_roles?: Array<"nurse" | "doctor" | "pharmacist">
}

export type Observation = {
  status: "readable" | "missing" | "unreadable"
  value?: string | null
  evidence?: EvidenceRef | null
}

export type PackageCapture = {
  version?: "1"
  case_id: string
  front: PhotoView
  reverse?: PhotoView | null
  packages?: Array<PhysicalPackage>
  reverse_matches?: Array<ReverseMatch>
  sources?: Array<EvidenceSource>
}

export type PackageEvidence = {
  item_id: string
  source_id: string
  kind: "label" | "appearance"
  region: RegionLink
}

export type PackageItem = {
  row_id: string
  kind: "order" | "pending_appearance"
  evidence: Array<PackageEvidence>
}

export type PackageRegionResult = {
  regions: Array<RegionBounds>
  side: "front" | "reverse"
  attachment_id: string
  revision: number
  case_id: string
}

export type PharmacistApproval = {
  pharmacist_id: string
  approved_at: string
  row_revision: number
}

export type Photo = {
  media_type: "image/jpeg" | "image/png" | "image/webp"
  data: string
  region: [number, number, number, number]
  bag: string
  pairing: "matched" | "uncertain"
  appearance?: string | null
  front_attributed?: boolean
}

export type PhotoRegion = {
  id: string
  bounds: RegionBounds
  visibility?: "visible" | "opaque"
}

export type PhotoView = {
  attachment_id: string
  revision: number
  exif_orientation?: number
  coordinate_space?: "exif_transposed_display"
  visibility?: "visible" | "opaque"
  regions?: Array<PhotoRegion>
}

export type PhysicalPackage = {
  id: string
  front_regions: Array<RegionLink>
  items?: Array<PackageItem>
}

export type PillCandidate = {
  reference_id: string
  fictional_medication: string
  image_reference: string
  matches: Array<string>
  differences: Array<string>
}

export type PillCropUpload = {
  crop: EvidenceRef
  media_type: "image/png" | "image/jpeg" | "image/webp"
  image_base64: string
}

export type PillObservation = {
  row_id: string
  crop: EvidenceRef
  imprint: Observation
  shape: Observation
  form: Observation
  color: Observation
  overlapping?: boolean
  follow_up?: string | null
}

export type PillObservationRequest = {
  evidence: CaseEvidence
  crops: Array<PillCropUpload>
}

export type ProductOption = {
  tpu: string
  label: string
  active_tmt: boolean
  source_generic: string
  strength: string
  dose_form: string
}

export type ProductOptions = {
  tmt_release: string
  products: Array<ProductOption>
}

export type Proposal = {
  action: "propose"
  row_id: string
  name: string
  reference: string
}

export type Refer = {
  action: "refer"
  row_ids: Array<string>
  checked: string
  reason: string
}

export type Reference = {
  title: string | null
  url: string | null
}

export type ReferenceVersion = {
  name: string
  version: string
}

export type RegimenComponent = {
  component_id: string
  basis: "documented" | "reported" | "verified"
  parse_status: "complete" | "partial" | "unparsed"
  unparsed_text?: string | null
  directions_text: string
  dose_amount?: number | null
  dose_unit?: string | null
  schedule_type?: "frequency" | "interval" | null
  frequency_count?: number | null
  period_value?: number | null
  period_unit?: "hour" | "day" | "week" | "month" | null
  time_of_day?: Array<string>
  route?: string | null
  meal_relation?: string | null
  as_needed?: boolean | null
  evidence: Partial<Record<"directions_text" | "dose_amount" | "dose_unit" | "schedule_type" | "frequency_count" | "period_value" | "period_unit" | "time_of_day" | "route" | "meal_relation" | "as_needed", EvidenceRef>>
}

export type RegimenParseRequest = {
  evidence: CaseEvidence
  row_id: string
  component_id: string
  basis: "documented" | "reported"
  directions_text: string
  source: EvidenceRef
}

export type RegimenParseResult = {
  row_id: string
  regimens: Array<RegimenComponent>
}

export type RegionBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type RegionLink = {
  case_id: string
  side: "front" | "reverse"
  attachment_id: string
  revision: number
  region_id: string
}

export type ReverseMatch = {
  package_id: string
  region: RegionLink
  status: "candidate" | "confirmed"
}

export type ReviewRow = {
  id: string
  identity_status: "named" | "unlabeled" | "unreadable"
  unknown_label?: string | null
  sources: Array<EvidenceRef>
  dispensing_source_id?: string | null
  observed_names?: Array<SourcedValue>
  label_fields?: Partial<Record<LabelField, Observation>>
  reported_use?: Array<SourcedValue>
  regimens?: Array<RegimenComponent>
  reverse_crop?: EvidenceRef | null
  discrepancies?: Array<Discrepancy>
  follow_ups?: Array<FollowUp>
  revision: number
  verification?: CurrentUseVerification | null
  approval?: PharmacistApproval | null
}

export type ReviewerIdentity = {
  id: string
  name: string
  role: "pharmacist" | "doctor" | "nurse" | "staff"
}

export type RuleMatch = {
  rule_id: string
  relevance: string
  consequence: string | null
  condition: string | null
  mechanism: string | null
  source_basis: string | null
  updated: string
  references: Array<Reference>
  matched_atcs: [Array<string>, Array<string>]
}

export type RunReport = {
  snapshot_id: string
  enabled?: boolean
}

export type ScopeCoverage = {
  total_scopes: number
  evaluated_scopes: number
  findings: number
  excluded_scopes: number
}

export type ScreenedPair = {
  row_ids: [string, string]
  ddi: DDILookup
  duplicate: DuplicateLookup
}

export type ScreenedRow = {
  row_id: string
  label: string
  tpu?: string | null
  reason?: string | null
  composition_status?: string | null
  ddi_status?: string | null
  route_note?: string | null
  evidence?: Array<EvidenceRef>
}

export type ScreeningScope = {
  scope_id: string
  parent_scope_id?: string | null
  row_ids: Array<string>
  ingredient_ids?: Array<string>
  rule_id?: string | null
  rule_version?: string | null
  outcome: "finding" | "no_finding" | "unevaluated"
  reason_code?: string | null
  evidence_ids?: Array<string>
  reference_section?: string | null
  follow_up_ids?: Array<string>
}

export type ServiceError = {
  code: string
  message: string
  recoverable: boolean
  row_ids?: Array<string>
}

export type SnapshotUpdate = {
  admission_revision: number
  previous_snapshot_id?: string | null
  exposures?: Array<ExposureObservation>
}

export type SnapshotVersion = {
  case_id: string
  snapshot_id: string
  admission_revision: number
  release_id: string
  mapping_version: string
  current: boolean
}

export type SourceEntry = {
  source: EvidenceSource
  wording: string
  name?: string | null
  strength?: string | null
  form?: string | null
  dose?: string | null
  record_basis?: "documented_interview" | "discontinuation_order" | null
  scan_fields?: Partial<Record<LabelField, Observation>>
  identity_basis?: "matched_original_package" | "dispensing_confirmation" | "item_specific_record" | null
  label_owner?: string | null
  directions?: string | null
  indication?: string | null
  directions_status?: "missing" | "unreadable"
  photo?: Photo | null
}

export type SourceKind = "label_photo" | "reverse_photo" | "additional_photo" | "prescription" | "transfer_record" | "patient_report" | "caregiver_report" | "reviewer_record" | "other_record"

export type SourcedValue = {
  value: string
  evidence: EvidenceRef
}

export type ValidationError = {
  loc: Array<string | number>
  msg: string
  type: string
  input?: unknown
  ctx?: Record<string, unknown>
}

export type Verify = {
  action: "verify"
  row_id: string
  source_id: string
  identity_source_id?: string | null
  resolution?: string | null
}

export type VersionedScreeningReport = {
  case_id: string
  snapshot_id: string
  release_id: string
  kind: "DDI" | "DRP"
  status: "not_run" | "unavailable" | "partial" | "complete"
  simulated?: true
  ran_at: string | null
  coverage: ScopeCoverage
  scopes: Array<ScreeningScope>
  mapping_version: string
  warnings?: Array<string>
}
