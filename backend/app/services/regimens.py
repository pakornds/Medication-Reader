"""Conservative parsing of explicit, source-attributed directions in the transfer demo."""

import re

from app.schemas.regimen import RegimenComponent, RegimenParseRequest, RegimenParseResult, validate_regimen_evidence

# Match entire clauses. Unknown qualifications (ranges, tapers, negations, limits)
# must survive intact rather than being discarded after a plausible prefix match.
DOSE = r"(?P<amount>[0-9]{1,8}(?:\.[0-9]{1,6})?)\s+(?P<unit>tablets?|capsules?)"
NAMED_TIME = r"(?P<time>morning|afternoon|evening|night)"
INTERVAL = re.compile(
    r"(?:every\s+)(?P<period>[1-9][0-9]{0,7})\s+(?P<unit>hours?|days?|weeks?|months?)"
    r"(?:\s+(?P<prn>as needed)(?P<condition>\s+for\s+[^.;]+)?)?", re.IGNORECASE,
)
DOSE_PREFIX = re.compile(
    rf"(?:I take |take )?{DOSE}(?P<route> by mouth)?(?:\s+(?P<timing>.+))?", re.IGNORECASE,
)
THAI_DAILY = re.compile(
    r"(?:รับประทาน\s*)?(?:ครั้งละ\s*)?(?P<amount>[1-9][0-9]{0,7}(?:\.[0-9]{1,6})?)\s*"
    r"(?P<unit>เม็ด|แคปซูล)\s*ทุก(?:วันตอน|ตอน)?(?P<time>เช้า|กลางวัน|เย็น)"
)


def _timing(text: str) -> tuple[dict, str | None] | None:
    if match := INTERVAL.fullmatch(text):
        fields = {
            "schedule_type": "interval", "period_value": int(match["period"]),
            "period_unit": match["unit"].lower().rstrip("s"),
        }
        if match["prn"]:
            fields["as_needed"] = True
        remainder = match["condition"].strip() if match["condition"] else None
        return fields, remainder

    if match := re.fullmatch(rf"(?:each|every) {NAMED_TIME}", text, re.IGNORECASE):
        return {
            "schedule_type": "frequency", "frequency_count": 1, "period_value": 1,
            "period_unit": "day", "time_of_day": [match["time"].lower()],
        }, None
    if match := re.fullmatch(r"(once|twice)(?: a day| daily)", text, re.IGNORECASE):
        return {
            "schedule_type": "frequency", "frequency_count": {"once": 1, "twice": 2}[match[1].lower()],
            "period_value": 1, "period_unit": "day",
        }, None
    if match := re.fullmatch(rf"(?:I take it )?(?:in the )?{NAMED_TIME}", text, re.IGNORECASE):
        return {"time_of_day": [match["time"].lower()]}, None
    return None


def _clause(text: str) -> tuple[dict, str | None] | None:
    if match := THAI_DAILY.fullmatch(text):
        return {
            "dose_amount": float(match["amount"]), "dose_unit": {"เม็ด": "tablet", "แคปซูล": "capsule"}[match["unit"]],
            "schedule_type": "frequency", "frequency_count": 1, "period_value": 1, "period_unit": "day",
            "time_of_day": [{"เช้า": "morning", "กลางวัน": "noon", "เย็น": "evening"}[match["time"]]],
            **({"route": "oral"} if text.startswith("รับประทาน") else {}),
        }, None
    if match := DOSE_PREFIX.fullmatch(text):
        amount = float(match["amount"])
        if amount <= 0:
            return None
        fields = {"dose_amount": amount, "dose_unit": match["unit"].lower().rstrip("s")}
        if match["route"]:
            fields["route"] = "oral"
        if not match["timing"]:
            return fields, None
        timing = _timing(match["timing"])
        if timing is None:
            return None
        return fields | timing[0], timing[1]
    return _timing(text)


def parse_directions(request: RegimenParseRequest) -> RegimenParseResult:
    original = request.directions_text
    phrase = original.strip().removesuffix(".").strip()
    # Split only when both halves stand on their own and explicitly state a dose.
    pieces = re.split(r"\s+and\s+", phrase, flags=re.IGNORECASE)
    if len(pieces) > 1 and not all(DOSE_PREFIX.fullmatch(piece) for piece in pieces):
        pieces = [phrase]
    parsed = [_clause(piece) for piece in pieces]
    if len(pieces) > 1 and not all(
        result and result[1] is None and result[0].get("time_of_day") for result in parsed
    ):
        # A timing or qualifier could apply to both amounts. Preserve the whole statement.
        parsed = [None]
    if any(result is None for result in parsed):
        parsed = [({}, original)]

    regimens = []
    for index, (fields, remainder) in enumerate(parsed):
        fields["directions_text"] = original
        status = "complete" if remainder is None else ("unparsed" if len(fields) == 1 else "partial")
        component = RegimenComponent(
            component_id=request.component_id if index == 0 else f"{request.component_id}-{index + 1}",
            basis=request.basis, parse_status=status, unparsed_text=remainder,
            evidence={field: request.source for field in fields}, **fields,
        )
        validate_regimen_evidence(component, request.row_id, request.evidence)
        regimens.append(component)
    return RegimenParseResult(row_id=request.row_id, regimens=regimens)
