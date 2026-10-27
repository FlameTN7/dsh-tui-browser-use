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
/** A structurally-typed JSON Schema node (enforced subset). */
export interface SchemaNode {
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | string;
    oneOf?: SchemaNode[];
    properties?: Record<string, SchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: SchemaNode;
    enum?: unknown[];
    const?: unknown;
}
/** Validate a value against a schema node. Returns path-qualified violations. */
export declare function validateJsonSchema(schema: SchemaNode, value: unknown, path?: string): string[];
/** Heuristically parse a JSON object/array out of a vision-model text reply. */
export declare function parseJsonReply(text: string): unknown;
//# sourceMappingURL=schema-validate.d.ts.map