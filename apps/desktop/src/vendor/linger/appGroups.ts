// Adapted from Linger d4dd925, apps/web/src/features/apps/app-groups.ts.
// Copyright (c) 2026 SIMPLEX AI TECHNOLOGIES PTE. LTD.
// The shipped Linger license is in public/third-party/Linger.txt.

const APP_GROUPS = [
  { id: "development", title: "Development", apps: ["github"] },
  { id: "documents", title: "Documents", apps: ["feishu", "lark"] },
  { id: "custom", title: "Custom sources", apps: ["mcp"] },
] as const;

export function groupCatalogApps<App extends { id: string }>(apps: readonly App[]) {
  const byKey = new Map(apps.map((app) => [app.id, app]));
  const groups = APP_GROUPS.map((group) => ({
    group: { id: group.id, title: group.title },
    apps: group.apps.flatMap((key) => byKey.get(key) ?? []),
  }));
  const known = new Set<string>(APP_GROUPS.flatMap((group) => [...group.apps]));
  groups.at(-1)?.apps.push(...apps.filter((app) => !known.has(app.id)));
  return groups.filter((entry) => entry.apps.length > 0);
}
