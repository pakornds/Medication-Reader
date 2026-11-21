# Demo walkthrough

All demo records are synthetic. The names and identifiers in the catalogue are reference data. The sample label wording is for demonstrating the software.

[Animated walkthrough](walkthrough.gif) · [Input](input.png) · [Review](review.png) · [Output](output.png) · [History](history.png)

The walkthrough was captured in the running app. It shows live OpenAI extraction from two manually marked synthetic labels, local TMT and FEST lookups, the JSON handoff, and the reopened History entry.

## Try the review without an API key

Start the app using the [local setup](../../README.md#run-locally). The bundled February 2020 TMT release contains these catalogue products.

| Code to search | Product |
| --- | --- |
| `108354` | MAFORAN, warfarin sodium 5 mg tablet |
| `250763` | ASLAC-B, aspirin 81 mg tablet |

1. In **Input**, choose **Enter medicine manually**. Search for each code, select the catalogue result, and choose **Add to draft**.
2. Choose **Continue to Review**, then **Check medicines**. FEST flags a potential interaction with **Partly assessed** coverage. Open the source rules to see the mapped classifications and the original references.
3. Select the medicines to include and choose **Prepare handoff**. In **Output**, use **Copy medicine list** for tab-separated text or **Download JSON** for structured fields, the selected TMT codes, and the source fields that are present.
4. Open **History** and expand the completed handoff. It retains the reviewed medicine fields and timestamp.

To see a classification-specific finding, start a fresh case and check ASLAC-B `250763` with MEDPROFEN `1005874` (ibuprofen). The pinned references show **Possible interaction · confirm indication** for the supported aspirin classification. To see a coverage gap, add a row called `Synthetic unlisted medicine` without choosing a catalogue product. Pairs involving that row remain **Unassessed**.

## Read a Thai label photo

1. Copy the repository's [`.env.example`](../../.env.example) to `.env` and set `OPENAI_API_KEY` and `OPENAI_MODEL`. Use an [OpenAI Responses model with image input and Structured Outputs](https://developers.openai.com/api/docs/models/gpt-6.1-terra) available to your project.
2. Stop the backend if it is already running on port 8000. From the repository root, load the local environment and restart it. These commands assume the Python environment from the [local setup](../../README.md#run-locally).

   ```sh
   set -a
   . ./.env
   set +a
   python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
   ```

3. Download the [synthetic Thai label image](synthetic-thai-labels.png). In **Input**, use **Upload photos** and **Choose photo** on the label side. For this flat illustration, open **Mark or adjust individual items** and select two opposite corners of each white label. Automatic package detection returned no regions on this illustration. Choose **Analyze evidence** after marking both labels.
4. Inspect the draft rows. Expand **View source and details** to compare the Thai wording with the draft dose and schedule. Use **Change match** or **Find catalogue match** to select the codes above if needed. Follow the same Review and Output steps.

**Paste text** uses the same analysis service and draft. It can take a plain medication list or a transfer note.
