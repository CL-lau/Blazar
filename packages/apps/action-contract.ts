import { Ajv } from 'ajv';

const schemas = new Ajv({ strict: true, addUsedSchema: false, ownProperties: true });

export function applicationWriteContract(config: Record<string, unknown>) {
  const { version, inputSchema, outputSchema } = config;
  if (version === undefined && inputSchema === undefined && outputSchema === undefined) return undefined;
  if (version !== 1 || !inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema) ||
      !('type' in inputSchema) || inputSchema.type !== 'object' ||
      !outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) {
    throw new Error('Version 1 application capabilities require an object input schema and an output schema');
  }
  const input = schemas.compile(inputSchema);
  const output = schemas.compile(outputSchema);
  return {
    definition: { version, effect: 'write' as const, approval: 'required' as const, inputSchema, outputSchema },
    acceptsInput: (value: unknown) => input(value),
    acceptsOutput: (value: unknown) => output(value),
  };
}
