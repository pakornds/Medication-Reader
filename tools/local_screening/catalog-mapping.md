# Building the Thai product mapping

The builder joins a TMT release to a Norwegian FEST human-prescriber release and records the disposition of every Thai product. The database supports exact-ingredient duplication checks and candidate interaction lookups. Its product counts measure mapping coverage. A patient-level interaction still requires a supported pair, encounter evidence, and clinical review.

From this repository, using the local release layout:

```sh
uv run tools/local_screening/build_catalog_mapping.py \
  --tmt-root ../TMTRF20261116 --release TMTRF20261116 \
  --legacy ../medicines.json \
  --fest ../screening-research/FEST-prescriber-2.5.1-20261111.zip \
  --out ../screening-research
python -m pytest tools/local_screening/test_catalog_mapping.py
```

The script pins the Excel reader in its inline Python dependency declaration. With a provisioned Python 3.11+ environment containing `xlrd==2.0.2`, the same build works offline by replacing `uv run` with the Python executable. Each output is built in a temporary directory and replaced on successful completion. Keep the Thai source data and derived product files in the authorized local deployment. Confirm terms for the specific TMT release before redistributing any derived mapping. The FEST source is published by the Norwegian Medical Products Agency under NLOD 2.0. [Thai terminology publisher](https://this.or.th/service/tmt/about/) · [Norwegian publisher's terms](https://www.dmp.no/en/about-us/distribution-of-data-on-medicinal-products/electronic-prescription-support-system-fest/responsibility-when-using-fest)

## Rules behind a usable mapping

1. Start with every TPU in the **active TMT snapshot**. Retain older catalogue products absent from this release as explicitly ineligible. This is terminology activity. Registration, sale and local formulary status have independent sources.
2. Traverse TPU → GPU → GP → VTM → SUBS from the four relationship workbooks. Require unique intermediate links and complete substance records. Check the names of all SUBS concepts against the release master's entire active-ingredient field. A mismatched set goes to review. Named mixtures such as extracts and vaccines covered by the builder's complex-substance filter also go to review. Overlap is computed at the exact TMT SUBS level. Distinct salt or ester IDs can hide a shared active moiety until a separate reviewed relationship is available.
3. Match each Thai SUBS to one distinct active FEST substance using its complete English name. Normalization is limited to Unicode NFC, letter case and whitespace. No guessed translations, stem matching, or salt/ester stripping are performed.
4. Read active Norwegian branded and generic drug records, their explicit strength-to-substance references, the pharmaceutical form code, the route code and the English terms of the ATC dictionary. Require the same entire set of ingredient IDs, a configured equivalent form, and the single route specified by that form mapping. Generic injection or cream alone provides insufficient route specificity in this policy. Norwegian conventional oral tablet code 53 includes standard film-coated tablets. The clinical encounter's actual route and indication still need verification.
5. For a single-ingredient Norwegian product, use its explicit ATC code. For a Norwegian combination, require each component's explicit `AtcKombipreparat`. Each component must have its own full seven-character ATC code and the dictionary's English term for that code must identify the same exact substance. The code for the combination as a whole cannot establish component identity. All eligible active Norwegian comparison products must agree on the complete mapping. Ambiguity or unsupported class labels remain excluded. This is a candidate mapping of ingredient and form/route, independent of product strength, diagnosis and brand equivalence.
6. An existing selection from the historical catalogue whose ingredient, form or strength text changed requires a fresh identity check. A fresh selection verified with the current TMT release uses the current disposition. Only `composition_status=complete` supports the exact-ingredient check. Only `ddi_status=mapped` supplies product ATCs for the FEST candidate search. The implementation still needs to apply the individual rule's exposure and other prerequisites.

## Outputs and interpretation

| File | Contents |
| --- | --- |
| `tmt-fest-mapping.sqlite` | Product dispositions, ingredients, mapped product ATCs and supporting Norwegian product IDs, plus release metadata. Tables `product`, `ingredient`, `product_atc`, `fest_evidence` and `metadata`. Where a product is unresolved, diagnostic ingredient links may still be present. Honor its disposition before consuming them. |
| `tmt-fest-products.csv` | One row per TPU in either catalogue with release membership, ingredient IDs, form, eligibility and specific exclusion, Norwegian reference count, and historical dispositions. |
| `tmt-fest-coverage.json` | Active, historical and union cohort counts. Includes input file hashes, including the builder, the policy version, and counts of active Norwegian product records examined. |
| `tmt-fest-coverage.csv` | Same cohort metrics in tabular form. Dimensions have separate denominators. |

The metadata `mapping_sha256` fingerprints the versioned input manifest and exact builder source. `fest_sha256` fingerprints the source ZIP and must match the interaction-rule index. For the November 2026 inputs, the active TMT snapshot has 34,567 products. Of these, 33,612 have a usable exact-substance composition and 10,568 have a complete ingredient-level ATC mapping. The latter include 564 combinations. The 30,683 products in the older export yield 28,493 usable compositions and 9,320 ATC mappings without changing a historical selection. Another 1,498 historical selections need reconfirmation after clinical fields changed. In the current release 38 historical TPUs are absent. Rebuilding with another release can change all counts.

Examples in this release include `117365 / simvastatin / C10AA01` and `658786 / clarithromycin / J01FA09`. The exposures, clinical significance and recommended response come from separate evidence. Missing mappings, unsupported interactions and absent patient context must remain visible in the review. The mapping has not been independently validated as a clinical terminology crosswalk.
