# Local medication screening

The review workspace at `/review/` searches the Thai product catalogue, records the reviewed product and its evidence, and looks up potential interactions and shared active ingredients. Both lookups run inside FastAPI using read-only local databases. A fresh checkout includes compressed SQLite files for the public 2020 Thai release and the November 2026 FEST release. No clinical database API or model call is involved.

## What the datasets contain

| Source | Role in review |
| --- | --- |
| TMT February 2020 | The original application catalogue (`medicines.json`). The audit tracks old product codes, including changed and absent entries. |
| TMT November 2026 | The current release used in this evaluation. The active snapshot identifies products, and relationships link each product unit (TPU) through generic concepts to its substance IDs (SUBS). Strength and form describe the selected product. |
| Norwegian FEST prescriber XML, November 11, 2026 | Product and substance records support cross-catalogue mapping. Separate interaction records contain two groups, source relevance, consequences, qualifying circumstances, and references. Some groups use a parent ATC covering its descendants. This extract has 11,159 active interaction records and 457 separate unassessed entries. |
| Derived TMT–FEST database | One disposition for every TPU in either catalogue, the evidence supporting each accepted formulation mapping and the reason for each omission. Both checks use the same verified row. Ingredient comparison can succeed when DDI mapping fails. |

Contains information from the Norwegian Medical Products Agency (DMP), made available under NLOD 2.0. The crosswalk and SQLite representation are project derivatives. Refresh and re-evaluate the crosswalk when reference releases change. Confirm the applicable TMT release rights before distributing the derived Thai product data. [TMT terminology](https://this.or.th/service/tmt/about/) · [FEST releases](https://www.dmp.no/en/about-us/distribution-of-data-on-medicinal-products/electronic-prescription-support-system-fest/downloading-fest-and-safest) · [FEST implementation guide, chapter 8](https://www.dmp.no/contentassets/3cb9b85e742745d4b1db7d899eb987b7/202511_implementation-guide-fest-v3.6.pdf#page=64) · [NLOD terms](https://data.norge.no/nlod/en/2.0)

## Measured coverage

| Population | Product units | Eligible for exact TMT substance comparison | Product-to-FEST mapping |
| --- | ---: | ---: | ---: |
| Bundled February 2020 products assessed against the 2020 TMT records | 30,683 | 30,160 (98.3%) | 9,537 (31.1%) |
| Active November 2026 products selected in this release | 34,567 | 33,467 (96.8%) | 10,568 (30.6%) |
| Original February 2020 selections carried into the November 2026 catalogue without reconfirmation | 30,683 | 28,385 (92.5%) | 9,320 (30.4%) |

The release cohorts overlap. Of the original catalogue, 38 product codes are absent from the new snapshot and 1,498 have changed clinical fields. Reconfirm changed products from the current catalogue. The active DDI-mapped set includes 564 combination products with all components mapped. Strength-dependent applicability still requires review of the individual case. The comparison matches ingredients, form and route conservatively, without fuzzy names or automatic salt substitution. [Mapping methodology and reproducible build](../../tools/local_screening/catalog-mapping.md)

| First reason the active product could not be mapped for DDI | Products |
| --- | ---: |
| No matching FEST formulation for the recorded composition, form and route | 8,828 |
| Thai form or route outside the supported crosswalk | 8,658 |
| No exact FEST substance identity for at least one ingredient | 4,611 |
| TMT composition unresolved | 1,100 |
| Component ATC assignment unsupported | 750 |
| More than one possible ATC assignment | 52 |

The 1,100 unresolved compositions comprise 485 disagreements between the TMT graph and the master ingredient field, 598 complex substance descriptions withheld for review, and 17 missing or ambiguous product chains. Even a mapped product can have an explicit FEST coverage gap. In this release 566 mapped TPUs have only ATCs carrying an exact unassessed notice. A positive rule remains visible when an unassessed notice is also present. A scope with no returned rule provides no clinical safety clearance.

Across the mapped catalogue, **3,110 of the 11,159 source rules** have opposite sides reachable by at least two distinct active Thai product codes. **9,437 of the 10,568 mapped products** can reach at least one such partner. This counts possible catalogue matches under the ATC lookup. It measures neither patient exposure nor clinical accuracy. Run `tools/local_screening/audit_rule_reach.py` with the mapping and FEST SQLite paths to reproduce it.

## Run the review

From a fresh checkout, install the bundled databases with Python 3.12. This step runs offline and uses only the standard library. Start the backend from the repository root.

```sh
python tools/local_screening/install.py
python -m pip install -e backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The default uses **TMT February 2020** and **FEST November 2026**. The installer verifies both uncompressed database hashes and places them under `reference-data/installed/`. Rerunning it selects the bundled historical release. Existing `LOCAL_TMT_DB` and `LOCAL_FEST_DB` settings override those paths. A packaged backend running outside this checkout can use these settings to point to the installed SQLite files. [Reference files and attribution](../../reference-data/README.md)

To reproduce the public Thai mapping from publisher workbooks, run `uv run --with xlrd==2.0.2 tools/local_screening/install.py --rebuild-2020`. To select the audited **November 2026 Thai catalogue**, use the following command with the extracted directory containing the snapshot and bonus folders. Both rebuild modes use the public 2020 ZIP to preserve historical selections. Supply `--tmt-2020-zip /path/to/public.zip` for an offline rebuild with the dependency already installed. Each mode prints its release and measured coverage.

```sh
uv run --with xlrd==2.0.2 tools/local_screening/install.py --tmt-2026-root /path/to/TMTRF20261116
```

From a source checkout, open [the local review workspace](http://127.0.0.1:8000/review/). Search by TPU, trade name, or ingredient. Select each product, record source wording and current-use evidence, and verify the row. A catalogue selection alone stays pending. Add an unidentified medicine when necessary. Choose **Check interactions and shared ingredients**. The report shows each row, pair, coverage gaps, and the references for potential findings. Changing a row clears superseded results. The existing regimen review uses the same panel. Hospital import remains a separate pharmacist action.

The medicine-list Review page's **Check medicines** uses catalogue selections. An exact product-to-ATC mapping takes priority. For a conventional tablet or hard capsule with one documented TMT ingredient and a missing exact FEST match, the checker resolves the ingredient by exact name or a unique FDA UNII synonym. It checks FEST products on the same route and keeps every documented ATC with compatible formulation evidence. If the precise ingredient lacks product records for that route, the checker can use a unique exact leaf under an ATC group explicitly named for oral preparations. It can also follow a single published FEST link from the full substance to its therapeutic part and check the latter's product records on the same route. Incomplete route evidence, ambiguous ingredient identities and unsupported forms leave the ingredient unassessed. The index is generated from source releases and used offline.

Both mapping paths use the same FEST rule groups and source conditions. An actionable ingredient-level match keeps the original FEST references, adds its mapping evidence, and is marked **Partly assessed**. A fallback without an actionable finding leaves the pair **Unassessed**. For explicitly documented alternate classifications, such as aspirin for antiplatelet use or pain relief, the check presents a shared warning only if every supported classification has an actionable FEST rule. Every classification must have evidence for a compatible conventional form. Review shows the individual rules and leaves the actual product indication open. The lookup uses the catalogue route. The patient's actual use and timing remain for review. Combination products with no exact mapping, other routes, and modified-release or otherwise unsupported forms are outside this fallback. The verified staff workflow uses its existing exact-product and route checks.

To reproduce the shipped ingredient index, use the FDA archive pinned in the [reference-data notes](../../reference-data/README.md). To rebuild and measure coverage, run the following from the source checkout.

```sh
python tools/local_screening/build_ingredient_routes.py \
  reference-data/fest-20261111/FEST-prescriber-2.5.1-20261111.zip \
  reference-data/fest-20261111/ingredient-routes.json.gz \
  --unii-archive /path/to/UNIIs.zip
python tools/local_screening/audit_ingredient_coverage.py \
  reference-data/installed/tmt-fest-mapping.sqlite \
  reference-data/installed/fest-interactions.sqlite
```

Pass `--ddinter-dir /path/to/local/csvs` to compare the eight official DDInter exports. The audit identifies major or moderate DDInter pairs with exact ingredient names in single-ingredient TMT products. It reports whether the ingredients have supported ATCs and can reach a shared actionable FEST rule. The audit counts only single-code fallback mappings. These counts measure catalogue reach across available presentations. They do not establish rule applicability to a particular patient, frequency of real prescribing, or agreement on severity. The runtime uses FEST and does not load DDInter. [DDInter downloads](https://ddinter2.scbdd.com/download/) · [Data terms](https://ddinter2.scbdd.com/terms/)

The source-checkout review uses a declared reviewer role. Clinical identity management, formal validation of the crosswalk, Thai translations and a hospital-specific alert policy are deployment work. Unidentified, stopped, uncertain, stale, or inadequately sourced selections remain outside the appropriate checks. An overlap means two products list the same TMT substance ID and can represent intentional therapy. Constituents without their own codes, equivalent salts and class duplication are outside this comparison. FEST lookup covers indexed ATC groups. Named-only rule arms, patient-specific dose and timing applicability, and broad DRP assessment require further work.

**Reproducible case.** Select ZOCOR `117365`, KLACID `658786`, and BESTATIN 10 `117222`. Record a synthetic independent source and current use for each, then add one unidentified item. The six pairs include two potential FEST findings, one shared simvastatin SUBS code (`225411`) between the statin products, and three unassessed pairs involving the unidentified row. The ZOCOR/KLACID record is `ID_5C9536F2-D3D6-4E7A-8030-9F8A012690D5` with six citations. Adding C.M.D. injection `102831` demonstrates how a known composition can support the duplicate check while an unmapped administration route leaves DDI unassessed. The encounters used for testing are synthetic. The reference data and runtime lookups are real.

Existing fixture callers can continue to use `POST /checks`. The new review uses `GET /checks/local/products?q=…` and `POST /checks/local` with the case evidence manifest and review rows.
