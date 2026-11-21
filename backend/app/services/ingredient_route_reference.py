"""Resolve supported oral ingredient ATCs independently of the interaction rules."""

import gzip
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from app.schemas.local_screening import Reference
from app.services.local_reference_db import INSTALL_DIR

REFERENCE_PATH = INSTALL_DIR.parent / "fest-20261111" / "ingredient-routes.json.gz"
FEST_URL = "https://www.dmp.no/en/about-us/distribution-of-data-on-medicinal-products/electronic-prescription-support-system-fest/downloading-fest-and-safest"
FDA_UNII_URL = "https://precision.fda.gov/uniisearch"
WHO_ATC = "https://atcddd.fhi.no/atc_ddd_index/?code="
ORAL = "53"
# FEST 7448 conventional tablet (including film-coated) and hard capsule. Keep
# modified release, gastro-resistant, other administration routes and mixtures out.
ORAL_SOLID_FORMS = frozenset({"53", "891"})
EXACT_FORM_GAP = "no_exact_fest_product_form_route"
SUBSTANCE_GAP = "no_exact_fest_substance"
ATC = re.compile(r"[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}")
POLICY_VERSION = "ingredient-route-3"


@dataclass(frozen=True)
class IngredientATC:
    atcs: tuple[str, ...]
    references: list[Reference]


@dataclass(frozen=True)
class IngredientRoutes:
    version: str
    ingredients: dict
    blocked: dict
    parents: dict
    aliases: dict
    explicitly_oral: dict

    def is_blocked(self, name: str, route: str) -> bool:
        routes = self.blocked.get(name, ())
        return route in routes or "*" in routes

    def resolve(self, *, ingredients: dict[str, str], form_route: tuple[str, str],
                composition_status: str | None, ddi_status: str | None) -> IngredientATC | None:
        form, route = form_route
        if (composition_status != "complete" or ddi_status not in {EXACT_FORM_GAP, SUBSTANCE_GAP} or len(ingredients) != 1
                or route != ORAL or form not in ORAL_SOLID_FORMS):
            return None
        raw_name, = ingredients.values()
        name = " ".join(unicodedata.normalize("NFC", raw_name).casefold().split())
        references = []
        if ddi_status == SUBSTANCE_GAP:
            alias = self.aliases.get(name)
            if not alias:
                return None
            name = alias["target"]
            references.append(Reference(
                title=f"FDA UNII · {raw_name} = {name} ({alias['unii']})", url=FDA_UNII_URL,
            ))

        if self.is_blocked(name, route):
            return None
        source = self.ingredients.get(name, {}).get(route)
        if source is None and (oral := self.explicitly_oral.get(name)):
            atc = oral["atc"]
            references.append(Reference(
                title=f"ATC · {name} ({atc}), under {oral['group']} (oral preparations)",
                url=WHO_ATC + atc,
            ))
            return IngredientATC((atc,), references)

        if source is None and (parent := self.parents.get(name)):
            target = parent["target"]
            if self.is_blocked(target, route):
                return None
            references.append(Reference(
                title=f"FEST · {name} ({parent['precise_id']}), main ingredient {target} ({parent['parent_id']})",
                url=FEST_URL,
            ))
            name = target
            source = self.ingredients.get(name, {}).get(route)

        if source is not None:
            for atc, forms in sorted(source.items()):
                compatible = sorted(forms.keys() & ORAL_SOLID_FORMS)
                if not compatible:
                    return None
                product_id = forms.get(form) or forms[compatible[0]]
                references.append(Reference(title=f"FEST · {name} ({atc}), product {product_id}", url=FEST_URL))
            return IngredientATC(tuple(sorted(source)), references)

        return None


@lru_cache(maxsize=4)
def load_routes(fest_sha: str, path: Path = REFERENCE_PATH) -> IngredientRoutes | None:
    try:
        raw = gzip.decompress(path.read_bytes())
        payload = json.loads(raw)
        if payload["format_version"] != 2 or payload["fest_sha256"] != fest_sha:
            return None
        ingredients, blocked = payload["ingredients"], payload["blocked"]
        parents, aliases, explicitly_oral = payload["parents"], payload["aliases"], payload["explicitly_oral"]
        for routes in ingredients.values():
            for value in routes.values():
                if not isinstance(value, dict) or not value:
                    return None
                for atc, forms in value.items():
                    if not ATC.fullmatch(atc) or not isinstance(forms, dict) or not forms:
                        return None
                    if not all(isinstance(product, str) and product for product in forms.values()):
                        return None
        if any(not isinstance(routes, list) or not all(isinstance(route, str) for route in routes)
               for routes in blocked.values()):
            return None
        for links, keys in ((parents, ("target", "precise_id", "parent_id")), (aliases, ("target", "unii"))):
            if any(not all(isinstance(link[key], str) and link[key] for key in keys)
                   for link in links.values()):
                return None
        for value in explicitly_oral.values():
            atc, group = value["atc"], value["group"]
            if not ATC.fullmatch(atc) or len(group) not in {3, 4, 5} or not atc.startswith(group):
                return None
    except (OSError, EOFError, KeyError, TypeError, ValueError, AttributeError):
        return None
    version = f"{POLICY_VERSION}-{hashlib.sha256(raw).hexdigest()[:12]}"
    return IngredientRoutes(version, ingredients, blocked, parents, aliases, explicitly_oral)


# These summaries describe the whole FEST rule group, including drug-class members.
RULE_SUMMARIES = {
    "ID_45F34CDB-4002-4DA6-8846-9F8F00E6A177": (
        "Iron can reduce absorption of tetracycline antibiotics when taken together.",
        "ธาตุเหล็กอาจลดการดูดซึมยาปฏิชีวนะกลุ่มเตตราไซคลินเมื่อรับประทานพร้อมกัน",
    ),
    "ID_7CF378BE-9392-4278-B48E-A95E00B6774E": (
        "Using an opioid and gabapentin together can increase drowsiness and the risk of slowed breathing.",
        "การใช้ยาโอปิออยด์ร่วมกับกาบาเพนตินอาจทำให้ง่วงมากขึ้นและเพิ่มความเสี่ยงต่อการหายใจช้าลง",
    ),
    "ID_3278CC6E-A001-477A-B228-9F8A012763E8": (
        "Using warfarin and aspirin together can increase bleeding risk.",
        "การใช้วาร์ฟารินร่วมกับแอสไพรินอาจเพิ่มความเสี่ยงต่อการมีเลือดออก",
    ),
    "ID_CD3ACB87-D556-4458-9A2C-A1FD00FEEFAE": (
        "Using warfarin and aspirin together can increase bleeding risk.",
        "การใช้วาร์ฟารินร่วมกับแอสไพรินอาจเพิ่มความเสี่ยงต่อการมีเลือดออก",
    ),
}
