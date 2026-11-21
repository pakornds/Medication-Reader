"""Pinned ingredient-and-route mappings for specific FEST rules."""

from dataclasses import dataclass


@dataclass(frozen=True)
class IngredientRoute:
    substance_id: str
    ingredient: str
    forms: frozenset[str]
    route: str
    atc: str
    reference_url: str

    def matches(self, ingredients: dict[str, str], form: str, route: str) -> bool:
        return (
            ingredients == {self.substance_id: self.ingredient}
            and form in self.forms
            and route == self.route
        )


@dataclass(frozen=True)
class IngredientRouteRule:
    rule_id: str
    mapping_version: str
    ingredients: tuple[IngredientRoute, IngredientRoute]
    summary_en: str
    summary_th: str


TMT_RELEASE = "TMTRF20200217"
FEST_SHA256 = "cfca96f221b23864c06554e9723ce1336edf704ba17609d7c0694f81805c66f3"

# FEST route code 53 is oral. The WHO ATC records independently identify both
# ingredients as oral, and the installed TMT graph supplies the exact substances.
DOXYCYCLINE = IngredientRoute(
    "226372", "doxycycline", frozenset({"capsule, hard", "film-coated tablet"}),
    "53", "J01AA02", "https://atcddd.fhi.no/atc_ddd_index/?code=J01AA02",
)
FERROUS_FUMARATE = IngredientRoute(
    "689632", "ferrous fumarate", frozenset({"tablet"}),
    "53", "B03AA02", "https://atcddd.fhi.no/atc_ddd_index/?code=B03AA02",
)
TRAMADOL_HYDROCHLORIDE = IngredientRoute(
    "864627", "tramadol hydrochloride", frozenset({"tablet"}),
    "53", "N02AX02", "https://atcddd.fhi.no/atc_ddd_index/?code=N02AX02",
)
GABAPENTIN = IngredientRoute(
    "322132", "gabapentin", frozenset({"capsule, hard"}),
    "53", "N02BF01", "https://atcddd.fhi.no/atc_ddd_index/?code=N02BF01",
)

ORAL_IRON_DOXYCYCLINE = IngredientRouteRule(
    "ID_45F34CDB-4002-4DA6-8846-9F8F00E6A177", "oral-iron-doxycycline-1",
    (FERROUS_FUMARATE, DOXYCYCLINE),
    "Iron can reduce doxycycline absorption when taken together.",
    "ธาตุเหล็กอาจลดการดูดซึมด็อกซีไซคลินเมื่อรับประทานพร้อมกัน",
)
ORAL_TRAMADOL_GABAPENTIN = IngredientRouteRule(
    "ID_7CF378BE-9392-4278-B48E-A95E00B6774E", "oral-tramadol-gabapentin-1",
    (TRAMADOL_HYDROCHLORIDE, GABAPENTIN),
    "Using tramadol and gabapentin together can increase drowsiness and the risk of slowed breathing.",
    "การใช้ทรามาดอลร่วมกับกาบาเพนตินอาจทำให้ง่วงมากขึ้นและเพิ่มความเสี่ยงต่อการหายใจช้าลง",
)
RULES = {
    frozenset(ingredient.substance_id for ingredient in rule.ingredients): rule
    for rule in (ORAL_IRON_DOXYCYCLINE, ORAL_TRAMADOL_GABAPENTIN)
}
