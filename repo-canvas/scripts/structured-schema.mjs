import Ajv from "ajv";

// Schemas are trusted application contracts. Validation must never coerce,
// remove fields, insert defaults, or silently ignore unsupported keywords.
const ajv = new Ajv({ strict: true, allowUnionTypes: true, allErrors: false });
const validators = new Map();

export function structuredValidator(schema) {
  const key = JSON.stringify(schema);
  let validate = validators.get(key);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(key, validate);
    if (validators.size > 64) {
      const oldest = validators.keys().next().value;
      ajv.removeSchema(validators.get(oldest).schema);
      validators.delete(oldest);
    }
  }
  return validate;
}

export function validateStructuredValue(value, schema, label = "response") {
  const validate = structuredValidator(schema);
  if (validate(value)) return value;
  const error = validate.errors[0];
  const messages = {
    required: `обязательное поле ${error.params.missingProperty}`,
    additionalProperties: `неизвестное поле ${error.params.additionalProperty}`,
    type: error.params.type === "integer" ? "ожидается целое число" : `ожидается тип ${error.params.type}`,
    enum: "неизвестное значение", pattern: "неверный формат", maxLength: "превышена длина",
    minLength: "недостаточная длина", minItems: "недостаточно элементов", maxItems: "слишком много элементов",
  };
  throw new Error(`${label}${error.instancePath}: ${messages[error.keyword] || error.message}`);
}
