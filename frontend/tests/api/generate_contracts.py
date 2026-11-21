"""Regenerate the frontend wire types with the installed backend: python frontend/tests/api/generate_contracts.py."""
import json
from pathlib import Path

from app.main import app
from app.schemas.admission import CaptureCommand
from app.schemas.review import ServiceError
from app.services.medication_analysis import FormAnalysisInput


def ts(schema):
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "const" in schema:
        return json.dumps(schema["const"])
    if "enum" in schema:
        return " | ".join(map(json.dumps, schema["enum"]))
    for union in ("oneOf", "anyOf"):
        if union in schema:
            return " | ".join(ts(member) for member in schema[union])
    kind = schema.get("type")
    if kind == "array":
        if "prefixItems" in schema:
            return "[" + ", ".join(map(ts, schema["prefixItems"])) + "]"
        return f"Array<{ts(schema['items'])}>"
    if kind == "object":
        if "properties" in schema:
            fields = []
            for key, prop in schema["properties"].items():
                optional = "" if key in schema.get("required", []) else "?"
                fields.append(f"  {key}{optional}: {ts(prop)}")
            return "{\n" + "\n".join(fields) + "\n}"
        patterns = schema.get("patternProperties", {})
        if patterns and len(patterns) != 1:
            raise ValueError(f"Multiple record value types: {patterns}")
        values = next(iter(patterns.values()), schema.get("additionalProperties", True))
        value_type = ts(values) if isinstance(values, dict) else "unknown"
        if "propertyNames" in schema:
            key_schema = {"type": "string", **schema["propertyNames"]}
            return f"Partial<Record<{ts(key_schema)}, {value_type}>>"
        return f"Record<string, {value_type}>"
    if kind is None and set(schema) <= {"title", "description"}:
        return "unknown"
    return {"integer": "number", "number": "number", "boolean": "boolean",
            "string": "string", "null": "null"}[kind]


def generate():
    schemas = app.openapi()["components"]["schemas"]
    # Multipart JSON parts and error envelopes are validated inside the handlers.
    for model in (CaptureCommand, FormAnalysisInput, ServiceError):
        schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
        for name, definition in schema.pop("$defs", {}).items():
            schemas.setdefault(name, definition)
        schemas[model.__name__] = schema
    return "// Generated from FastAPI and its multipart models by tests/api/generate_contracts.py.\n\n" + "\n\n".join(
        f"export type {name} = {ts(schema)}" for name, schema in sorted(schemas.items())
    ) + "\n"


if __name__ == "__main__":
    path = Path(__file__).resolve().parents[2] / "src/api/contracts.ts"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(generate(), encoding="utf-8", newline="\n")
