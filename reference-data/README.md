# Screening reference data

| File | Source and use |
| --- | --- |
| [Thai product mapping](tmt-20200217/tmt-fest-mapping.sqlite.gz) | Derived from Thai Medicines Terminology, 17 February 2020, Thai Health Information Standards Development Center (THIS), obtained through Data.go.th. Product fields and TMT substance codes retain their source meanings. The project added formulation matching, coverage decisions and links to FEST evidence. The data package identifies the DGA Open Government License. [Original dataset](https://data.go.th/en/dataset/thai-medicines-terminology-tmt) · [DGA terms](https://data.go.th/en/pages/dga-open-government-license) |
| [FEST interactions](fest-20261111/fest-interactions.sqlite.gz) | Contains information from the Norwegian Medical Products Agency (DMP), made available under the Norwegian Licence for Open Government Data (NLOD) 2.0. The project indexed the prescriber interaction records in SQLite. [Source and responsibilities](https://www.dmp.no/en/about-us/distribution-of-data-on-medicinal-products/electronic-prescription-support-system-fest/responsibility-when-using-fest) · [NLOD 2.0](https://data.norge.no/nlod/en/2.0) |
| [FEST source archive](fest-20261111/FEST-prescriber-2.5.1-20261111.zip) | November 11, 2026 prescriber extract, version 2.5.1. The rebuild uses this exact archive to reproduce the same product and rule vocabulary. Same DMP source and NLOD 2.0 attribution as above. |

The bundled Thai catalogue is historical. The release dates appear in the review and the installer output. The November 2026 Thai mapping can be generated separately from an authorized release. Refresh both references and evaluate coverage before clinical deployment. [Install, rebuild and run](../docs/data/local-screening.md#run-the-review)
