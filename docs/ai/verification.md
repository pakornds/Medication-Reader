# Medication prompt verification

The server versions the label extraction, pill observation and form analysis
prompts as `label-extraction-v1`, `pill-observation-v1` and `form-analysis-v1`.
Run deterministic checks with `python -m pytest backend/tests/ai/test_prompts.py`.
The fixtures exercise bilingual transcription, unused approval instructions
inside evidence, the unknown-item source, and two failure modes for labels
sharing one photo. One failure cites the wrong region. The other cites the
right region with an unsupported value. The checks also reject unsupported
printed directions, patient-reported use and ward-note discrepancies.

For an opt-in smoke run, configure `OPENAI_API_KEY` and `OPENAI_MODEL` in the
backend environment. In PowerShell, run:

```powershell
$env:RUN_OPENAI_SMOKE = '1'
python -m pytest -q -s backend/tests/ai/test_prompts.py -k live
Remove-Item Env:RUN_OPENAI_SMOKE
```

The smoke uses only the synthetic transfer fixture and its two generated
images. In this case the nurse links the patient account to the first item.
Record the prompt version, configured model, date, and observed
assertion results. Keep API credentials and raw provider errors out of the
record.

| Date | Prompt version | Model | Result |
| --- | --- | --- | --- |
| 2026-11-21 | `form-analysis-v1` | Unconfigured | Live run pending backend credentials and a model. Deterministic fixture checks passed. |
