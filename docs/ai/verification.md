# Medication prompt verification

The server versions the label extraction, pill observation and form analysis
prompts as `label-extraction-v2`, `pill-observation-v1` and `form-analysis-v4`.
Run deterministic checks with `python -m pytest backend/tests/ai/test_prompts.py`.
The fixtures exercise bilingual transcription, unused approval instructions
inside evidence, the unknown-item source, and two failure modes for labels
sharing one photo. One failure cites the wrong region. The other cites the
right region with an unsupported value. The checks also reject unsupported
printed directions, patient-reported use and ward-note discrepancies.

For an opt-in smoke run, copy `.env.example` to `.env` and set the API key and
model locally. Git ignores `.env`. From the repository root in PowerShell,
load the two settings into the test process environment and run the smoke:

```powershell
try {
    Get-Content -LiteralPath .env | ForEach-Object {
        if ($_ -match '^(OPENAI_API_KEY|OPENAI_MODEL)=(.*)$') {
            Set-Item -LiteralPath "Env:$($Matches[1])" -Value $Matches[2]
        }
    }
    $env:RUN_OPENAI_SMOKE = '1'
    python -m pytest -q -s backend/tests/ai/test_prompts.py -k live
} finally {
    Remove-Item Env:OPENAI_API_KEY, Env:OPENAI_MODEL, Env:RUN_OPENAI_SMOKE -ErrorAction SilentlyContinue
}
```

The smoke uses only the synthetic transfer fixture and its two generated
images. In this case the nurse links the patient account to the first item.
Record the prompt version, configured model, date, and observed
assertion results. Keep API credentials and raw provider errors out of the
record.

| Date | Prompt version | Model | Result |
| --- | --- | --- | --- |
| 2026-11-21 | `form-analysis-v1` | `gpt-5.4-mini-2026-03-17` | Failed. The model combined the two printed names and included the conflicting ward name among them. |
| 2026-11-21 | `form-analysis-v2` | `gpt-5.4-mini-2026-03-17` | Failed exact transcription checks in two attempts, first on the visual dash in the directions and then on the Thai name after the fixture was clarified. |
| 2026-11-21 | `form-analysis-v2` | `gpt-5.4-2026-03-05` | Passed twice under the original evaluator. The stricter follow-up check rejected an identity discrepancy whose values did not match the cited sources exactly. |
| 2026-11-21 | `form-analysis-v2` | `gpt-6-luna` | The API returned structured output. Evidence validation rejected a documented field with a source that was neither a label nor a record. |
| 2026-11-21 | `form-analysis-v3` | `gpt-5.4-2026-03-05` | Passed the stricter check. The printed names, strengths, directions and expiry matched. The patient report retained its citation, the disputed names matched their respective sources, and the unlabeled row kept its matched crop and unresolved identity. |
| 2026-11-21 | `form-analysis-v3` | `gpt-6-luna` | The API returned structured output. Evidence validation rejected an evidence item that did not belong to the unlabeled row. |
