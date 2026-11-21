# Local medication screening

The review workspace at `/review/` searches the Thai product catalogue, records the reviewed product and its evidence, and looks up potential interactions and shared active ingredients. Both lookups run inside FastAPI using read-only local databases. The operator supplies the two release files. No clinical database API or model call is involved.

## What the datasets contain

| Source | Role in review |
| --- | --- |
| TMT February 2020 | The original application catalogue (`medicines.json`). The audit tracks old product codes, including changed and absent entries. |
| TMT November 2026 | The current release used in this evaluation. The active snapshot identifies products, and relationships link each product unit (TPU) through generic concepts to its substance IDs (SUBS). Strength and form describe the selected product. |
| Norwegian FEST prescriber XML, November 11, 2026 | Product and substance records support cross-catalogue mapping. Separate interaction records contain two groups, source relevance, consequences, qualifying circumstances, and references. Some groups use a parent ATC covering its descendants. This extract has 11,159 active interaction records and 457 separate unassessed entries. |
| Derived TMT–FEST database | One disposition for every TPU in either catalogue, the evidence supporting each accepted formulation mapping and the reason for each omission. Both checks use the same verified row. Ingredient comparison can succeed when DDI mapping fails. |

Contains information from the Norwegian Medical Products Agency (DMP), made available under NLOD 2.0. The crosswalk and SQLite representation are project derivatives. Refresh and re-evaluate the crosswalk when reference releases change. Confirm the applicable TMT release rights before distributing the derived Thai product data. [TMT terminology](https://this.or.th/service/tmt/about/) · [FEST releases](https://www.dmp.no/en/about-us/distribution-of-data-on-medicinal-products/electronic-prescription-support-system-fest/downloading-fest-and-safest) · [FEST implementation guide, chapter 8](https://www.dmp.no/contentassets/3cb9b85e742745d4b1db7d899eb987b7/202511_implementation-guide-fest-v3.6.pdf#page=64) · [NLOD terms](https://data.norge.no/nlod/en/2.0)

## Measured coverage

| Population | Product units | Complete TMT composition | Product-to-FEST mapping |
| --- | ---: | ---: | ---: |
| Active November 2026 products selected in this release | 34,567 | 33,617 (97.3%) | 10,568 (30.6%) |
| Original February 2020 selections, without reconfirmation | 30,683 | 28,496 (92.9%) | 9,320 (30.4%) |

The release cohorts overlap. Of the original catalogue, 38 product codes are absent from the new snapshot and 1,498 have changed clinical fields. Reconfirm changed products from the current catalogue. The active DDI-mapped set includes 564 combination products with all components mapped. Strength-dependent applicability still requires review of the individual case. The comparison matches ingredients, form and route conservatively, without fuzzy names or automatic salt substitution. [Mapping methodology and reproducible build](../../tools/local_screening/catalog-mapping.md)

| First reason the active product could not be mapped for DDI | Products |
| --- | ---: |
| No matching FEST formulation for the recorded composition, form and route | 8,828 |
| Thai form or route outside the supported crosswalk | 8,663 |
| No exact FEST substance identity for at least one ingredient | 4,756 |
| TMT composition unresolved | 950 |
| Component ATC assignment unsupported | 750 |
| More than one possible ATC assignment | 52 |

The 950 unresolved compositions comprise 485 disagreements between the TMT graph and the master ingredient field, 448 complex substance descriptions withheld for review, and 17 missing or ambiguous product chains. Even a mapped product can have an explicit FEST coverage gap. In this release 566 mapped TPUs have only ATCs carrying an exact unassessed notice. A positive rule remains visible when an unassessed notice is also present. A scope with no returned rule provides no clinical safety clearance.

Across the mapped catalogue, **3,110 of the 11,159 source rules** have opposite sides reachable by at least two distinct active Thai product codes. **9,437 of the 10,568 mapped products** can reach at least one such partner. This counts possible catalogue matches under the ATC lookup. It measures neither patient exposure nor clinical accuracy. Run `tools/local_screening/audit_rule_reach.py` with the mapping and FEST SQLite paths to reproduce it.

## Run the review

Build the FEST index and Thai crosswalk locally using the authorized source files. [Crosswalk builder instructions](../../tools/local_screening/catalog-mapping.md)

```sh
python tools/local_screening/build_fest_index.py \
  ../screening-research/FEST-prescriber-2.5.1-20261111.zip \
  ../screening-research/fest-interactions.sqlite
export LOCAL_TMT_DB="$PWD/../screening-research/tmt-fest-mapping.sqlite"
export LOCAL_FEST_DB="$PWD/../screening-research/fest-interactions.sqlite"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

From a source checkout, open [the local review workspace](http://127.0.0.1:8000/review/). Search by TPU, trade name, or ingredient. Select each product, record source wording and current-use evidence, and verify the row. A catalogue selection alone stays pending. Add an unidentified medicine when necessary. Choose **Check interactions and shared ingredients**. The report shows each row, pair, coverage gaps, and the references for potential findings. Changing a row clears superseded results. The existing regimen review uses the same panel. Hospital import remains a separate pharmacist action.

The source-checkout review uses a declared reviewer role. Clinical identity management, formal validation of the crosswalk, Thai translations and a hospital-specific alert policy are deployment work. Unidentified, stopped, uncertain, stale, or inadequately sourced selections remain outside the appropriate checks. Exact SUBS overlap can represent intentional therapy and excludes salt-equivalence or class duplication. FEST lookup covers indexed ATC groups. Named-only rule arms, patient-specific dose and timing applicability, and broad DRP assessment require further work.

**Reproducible case.** Select ZOCOR `117365`, KLACID `658786`, and BESTATIN 10 `117222`. Record a synthetic independent source and current use for each, then add one unidentified item. The six pairs include two potential FEST findings, one shared simvastatin SUBS code (`225411`) between the statin products, and three unassessed pairs involving the unidentified row. The ZOCOR/KLACID record is `ID_5C9536F2-D3D6-4E7A-8030-9F8A012690D5` with six citations. Adding C.M.D. injection `102831` demonstrates how a known composition can support the duplicate check while an unmapped administration route leaves DDI unassessed. The encounters used for testing are synthetic. The reference data and runtime lookups are real.

Existing fixture callers can continue to use `POST /checks`. The new review uses `GET /checks/local/products?q=…` and `POST /checks/local` with the case evidence manifest and review rows.
