// Adapted from Linger d4dd925, apps/web/src/features/apps/connection-state.ts.
// Copyright (c) 2026 SIMPLEX AI TECHNOLOGIES PTE. LTD.

export function activeExternalConnections<Connection extends { active: number }>(
  connections: readonly Connection[],
) {
  return connections.filter((connection) => connection.active === 1);
}
