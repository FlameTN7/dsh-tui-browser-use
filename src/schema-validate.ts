/**
 * dsh-tui-browser-use — minimal JSON Schema subset validator.
 *
 * Validates a JSON value against the enforced schema subset the harness uses
 * (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`,
 * `const`, `oneOf`). This is a structural, dependency-free checker so the
 * `browser.extract` tool can report `schema-validation-failed` without pulling
 * `@deepseek-ai/dsh-tools` at runtime (AGENTS.md §2).
 *
 * It is intentionally conservative: unknown keywords are ignored, and a schema
 * that uses an unsupported construct degrades to "accept any" (never a false
 * rejection of a conforming value) so extraction never hard-fails on a schema
 * wrinkle.
 */

import type { ErrorCode } from './types.js'

/** A structurally-typed JSON Schema node (enforced subset). */
export interface SchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | string
  oneOf?: SchemaNode[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  additionalProperties?: boolean
  items?: SchemaNode
  enum?: unknown[]
  const?: unknown
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isObject(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return true // unknown type keyword: accept any
  }
}

/** Validate a value against a schema node. Returns path-qualified violations. */
export function validateJsonSchema(schema: SchemaNode, value: unknown, path = '$'): string[] {
  const violations: string[] = []

  if (schema.oneOf !== undefined) {
    const matched = schema.oneOf.some((branch) => validateJsonSchema(branch, value, path).length === 0)
    if (!matched) violations.push(`${path}: value matches no oneOf branch`)
  }

  if (schema.enum !== undefined) {
    const matched = schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))
    if (!matched) violations.push(`${path}: value is not one of the allowed enum values`)
  }

  if (schema.const !== undefined) {
    if (JSON.stringify(schema.const) !== JSON.stringify(value)) {
      violations.push(`${path}: value does not equal the const ${JSON.stringify(schema.const)}`)
    }
  }

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    violations.push(`${path}: expected type ${schema.type}`)
    return violations
  }

  if (schema.type === 'object' || (schema.properties !== undefined && isObject(value))) {
    const obj = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in obj)) violations.push(`${path}.${key}: required property missing`)
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) violations.push(`${path}.${key}: additional property not allowed`)
      }
    }
    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) {
          violations.push(...validateJsonSchema(sub, obj[key], `${path}.${key}`))
        }
      }
    }
  }

  if (schema.type === 'array' && schema.items !== undefined && Array.isArray(value)) {
    value.forEach((item, i) => violations.push(...validateJsonSchema(schema.items!, item, `${path}[${i}]`)))
  }

  return violations
}

/** Heuristically parse a JSON object/array out of a vision-model text reply. */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim()
  // Strip markdown fences (` ```json ... ``` `) and surrounding prose.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1]!.trim() : trimmed
  // If the whole reply is JSON, parse directly.
  try {
    return JSON.parse(candidate)
  } catch {
    // fall through to bracket-scan
  }
  // Otherwise find the first balanced {...} or [...] block, ignoring braces
  // that appear inside JSON strings (a page value like {"x":"}"} must not
  // terminate the scan early).
  const start = candidate.search(/[\[{]/)
  if (start < 0) return undefined
  const open = candidate[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1)
        try { return JSON.parse(slice) } catch { return undefined }
      }
    }
  }
  return undefined
}

/** Wrap a schema-validation failure into a canonical error envelope. */
export function schemaValidationFail(message: string): { ok: false; error: { code: ErrorCode; message: string } } {
  return { ok: false, error: { code: 'schema-validation-failed', message } }
}
