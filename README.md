# Medication Reader

A medication reconciliation prototype for pharmacy and clinic staff to collect medication
evidence at transfer or urgent intake. Clinicians verify current use for the
encounter, then a pharmacist can approve selected rows for mock hospital import.

Install the bundled Thai catalogue and FEST interaction database with `python tools/local_screening/install.py` (Python 3.12). Both screening checks then work offline.

- [Run the admission interview, pharmacist referral and dated worksheet](docs/specs/reconciliation-contract.md#admission-encounters)
- [Local review setup, dataset coverage and unassessed cases](docs/data/local-screening.md)
- [V1 design and workflow diagram](docs/specs/medication-reader-v1.md)
- [AI behavior contract and acceptance cases](docs/ai/reconciliation-behavior.md)
- [Thai Medicines Terminology data source for local lookup evaluation](docs/data/tmt-2020.md)
- [Agent ticket and merge workflow](AGENTS.md)
- [Running the ticket queue with Codex](docs/RUNNING_TICKET_QUEUE.md)
