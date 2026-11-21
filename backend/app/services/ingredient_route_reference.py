"""Pinned ingredient-and-route evidence for the oral iron/doxycycline FEST rule."""

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


TMT_RELEASE = "TMTRF20200217"
FEST_SHA256 = "cfca96f221b23864c06554e9723ce1336edf704ba17609d7c0694f81805c66f3"
MAPPING_VERSION = "oral-iron-doxycycline-1"
RULE_ID = "ID_45F34CDB-4002-4DA6-8846-9F8F00E6A177"

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
