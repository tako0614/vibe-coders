import { RE2JS } from 're2js';
import { fieldSchema, type HumanSpec } from '../shared/contracts';

/** MCP elicitation supports flat primitives and string selections, never secret collection. */
export function mcpFields(schema: {
  properties?: Record<string, unknown>;
  required?: string[];
}): HumanSpec['fields'] {
  const entries = Object.entries(schema.properties || {});
  if (entries.length > 10) throw new Error('MCP form exceeds 10 fields.');
  return entries.map(([name, raw]) => {
    const f = raw as Record<string, any>;
    if (
      !f ||
      !['string', 'number', 'integer', 'boolean', 'array'].includes(f.type) ||
      /password|secret|token|api.?key/i.test(`${name} ${f.title || ''} ${f.description || ''}`)
    )
      throw new Error('Unsupported or sensitive MCP field.');
    const selection = f.type === 'array' ? f.items : f;
    let options: { value: string; label: string }[] | undefined;
    if (Array.isArray(selection?.enum))
      options = selection.enum.map((value: string, i: number) => ({
        value,
        label: selection.enumNames?.[i] || value,
      }));
    else if (Array.isArray(selection?.oneOf || selection?.anyOf))
      options = (selection.oneOf || selection.anyOf).map((o: any) => ({
        value: o.const,
        label: o.title || o.const,
      }));
    if (f.type === 'array' && (!options || (selection?.type && selection.type !== 'string')))
      throw new Error('Only string selection arrays are supported.');
    if (f.pattern !== undefined) RE2JS.compile(f.pattern);
    return fieldSchema.parse({
      name,
      label: f.title || name,
      type:
        f.type === 'array'
          ? 'multiChoice'
          : options
            ? 'choice'
            : f.type === 'string'
              ? 'text'
              : f.type,
      required: schema.required?.includes(name) ?? false,
      ...Object.fromEntries(
        [
          'description',
          'default',
          'pattern',
          'minimum',
          'maximum',
          'minLength',
          'maxLength',
          'format',
          'minItems',
          'maxItems',
        ]
          .filter((k) => k in f)
          .map((k) => [k, f[k]]),
      ),
      ...(options ? { options } : {}),
    });
  });
}
