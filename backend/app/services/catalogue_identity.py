"""Corroborate names on a single label with active products in the installed Thai TMT release."""
import sqlite3
import unicodedata
from concurrent.futures import ThreadPoolExecutor

from app.ai.client import ProviderError
from app.schemas.catalogue_identity import CatalogueIdentity
from app.services.catalogue_adjudication import adjudicate_names
from app.services.local_reference_db import open_reference


def _key(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _trade_name(label, ingredient):
    # TMT FSNs end the trade name with (manufacturer) (ingredients and strengths).
    # Preserve parentheses embedded in legitimate trade names, e.g. "(PLEURODESIS)".
    start = previous = None
    depth = 0
    first_ingredient = _key(ingredient.split(" + ")[0])
    for index, char in enumerate(label):
        if char == "(":
            if depth == 0:
                start = index
            depth += 1
        elif char == ")":
            if not depth:
                return None
            depth -= 1
            if depth == 0:
                group = _key(label[start + 1:index])
                if previous is not None and first_ingredient and (
                    group == first_ingredient or group.startswith(first_ingredient + " ")
                ) and label[previous[1] + 1:start].isspace():
                    return label[:previous[0]].strip() or None
                previous = (start, index)
    return None


FORM_ALIASES = {
    "เม็ด": "tablet", "tablets": "tablet", "แคปซูล": "capsule", "capsules": "capsule",
    "hard capsule": "capsule, hard", "hard capsules": "capsule, hard",
    "soft capsule": "capsule, soft", "soft capsules": "capsule, soft",
    "film coated tablet": "film-coated tablet",
    "eyedrops": "eye drops", "ยาหยอดตา": "eye drops",
}
FORM_FAMILIES = {
    "tablet": {"tablet", "coated tablet", "film-coated tablet"},
    "capsule": {"capsule", "capsule, hard", "capsule, soft"},
    "eye drops": {"eye drops", "eye drops, solution", "eye drops, suspension"},
}


def _matches_form(printed, form):
    key = _key(printed)
    key = FORM_ALIASES.get(key, key)
    return _key(form) in FORM_FAMILIES.get(key, {key})


def _supported_names(product, names):
    brand, generic = _key(product["trade_name"]), _key(product["ingredient"])
    if not names.intersection({brand, generic}):
        return False
    # An omitted final 'e' in a generic is permitted only alongside an exact
    # product or generic name. This never promotes an isolated near spelling.
    aliases = {brand, generic}
    if len(generic) >= 8 and generic.isascii() and generic.isalpha() and generic.endswith("e"):
        aliases.add(generic[:-1])
    return names.issubset(aliases)


def _label_query(row, label_items):
    if row.identity_status != "named" or any(
        d.field in {"identity", "strength", "form"} for d in row.discrepancies
    ):
        return None
    first = row.observed_names[0].evidence
    if (row.id, first.source_id, first.item_id) not in label_items or any(
        name.evidence != first for name in row.observed_names
    ):
        return None
    names = list(dict.fromkeys(n.value for n in row.observed_names))
    if len(names) > 8 or any(len(name) > 150 for name in names):
        return None
    qualifiers = {}
    for field in ("strength", "form"):
        fact = row.label_fields.get(field)
        if fact and fact.status == "readable":
            if fact.evidence != first:
                return None
            qualifiers[field] = fact.value
    return names, qualifiers.get("strength"), qualifiers.get("form"), first


def _retrieve(db, names, strength, form):
    keys = {_key(value) for value in names}
    placeholders = ",".join("?" for _ in keys)
    # Match the start of a complete trade-name segment or the entire generic.
    # instr parameters treat punctuation and LIKE wildcards literally.
    conditions = " OR ".join("instr(lower(label), ?) = 1" for _ in keys)
    rows = db.execute(f"""
        SELECT tpu, label, source_generic, source_strength, form FROM product
        WHERE active_tmt=1 AND (lower(source_generic) IN ({placeholders}) OR {conditions})
        ORDER BY length(label), tpu
    """, [*keys, *(key + " (" for key in keys)])
    groups = {}
    for row in rows:
        generic = row["source_generic"]
        brand = _trade_name(row["label"], generic)
        if not brand or not generic:
            continue
        product = dict(tpu=row["tpu"], trade_name=brand, ingredient=generic,
                       strength=row["source_strength"], form=row["form"])
        if not _supported_names(product, keys):
            continue
        if strength and _key(strength).replace(" ", "") != _key(product["strength"]).replace(" ", ""):
            continue
        if form and not _matches_form(form, product["form"]):
            continue
        # A generic alone never establishes a particular brand. All compatible
        # products must agree on the complete ingredient text before model review.
        trade = brand if _key(brand) in keys and _key(brand) != _key(generic) else None
        group = groups.setdefault((_key(generic), _key(trade or "")), (generic, trade, []))
        if len(groups) > 1:
            return None
        if len(group[2]) < 16:
            group[2].append(product)
    return next(iter(groups.values()), None)


def _label_items(items, sources):
    kinds = {s.id: s.kind for s in sources if s.availability == "available"}
    return {(i.row_id, i.source_id, i.id) for i in items
            if kinds.get(i.source_id) in {"label_photo", "additional_photo", "reverse_photo"}
            and i.supports_label(kinds[i.source_id])}


def supported_intake_identity(identity, row, items, sources):
    """Check an untrusted display hint against the current local release and original label."""
    if not identity:
        return None
    query = _label_query(row, _label_items(items, sources))
    if not query:
        return None
    names, strength, form_text, ref = query
    if identity.evidence != [ref]:
        return None
    try:
        with open_reference("LOCAL_TMT_DB") as db:
            version = db.execute("SELECT value FROM metadata WHERE key='tmt_release'").fetchone()
            if not version or version[0] != identity.release:
                return None
            matched = _retrieve(db, names, strength, form_text)
    except sqlite3.Error:
        return None
    if not matched:
        return None
    generic, trade, candidates = matched
    ids = set(identity.candidate_tpus)
    if (identity.ingredient, identity.trade_name) != (generic, trade) or (
        not ids or len(ids) != len(identity.candidate_tpus) or not ids.issubset(c["tpu"] for c in candidates)
    ):
        return None
    return identity.model_copy(update={"compatible_tpus": [item["tpu"] for item in candidates]})


def resolve_scan_identities(preview, form, get_provider):
    label_items = _label_items(form.evidence.items, form.evidence.sources)
    front_attachments = {s.attachment_id or s.id for s in form.evidence.sources
                         if s.kind in {"label_photo", "additional_photo"}}
    label_items.update((r.row_id, r.source_id, r.item_id) for r in preview.located_regions
                       if r.attachment_id in front_attachments)
    if not label_items:
        return {}
    jobs = []
    try:
        with open_reference("LOCAL_TMT_DB") as db:
            release = db.execute("SELECT value FROM metadata WHERE key='tmt_release'").fetchone()
            if not release or not release[0]:
                return {}
            for row in preview.rows:
                query = _label_query(row, label_items)
                if query:
                    names, strength, form_text, ref = query
                    matched = _retrieve(db, names, strength, form_text)
                    if matched:
                        jobs.append((row.id, names, strength, form_text, ref, matched))
    except sqlite3.Error:
        return {}

    def adjudicate(job):
        row_id, names, strength, form_text, ref, (ingredient, trade, candidates) = job
        try:
            proposed = adjudicate_names(get_provider(), names=names, candidates=candidates,
                                        strength=strength, form=form_text)
        except ProviderError:
            return None
        available = {c["tpu"] for c in candidates}
        if not proposed or not set(proposed).issubset(available):
            return None
        return row_id, CatalogueIdentity(ingredient=ingredient, trade_name=trade, release=release[0],
                                          candidate_tpus=list(dict.fromkeys(proposed)),
                                          compatible_tpus=[candidate["tpu"] for candidate in candidates], evidence=[ref])

    with ThreadPoolExecutor(max_workers=3) as workers:
        return dict(result for result in workers.map(adjudicate, jobs) if result is not None)
