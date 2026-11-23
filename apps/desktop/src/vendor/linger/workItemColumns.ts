// Adapted from Linger d4dd925, apps/web/src/features/work-items/work-items-page.tsx.
// Copyright (c) 2026 SIMPLEX AI TECHNOLOGIES PTE. LTD.

export const dashboardColumns = [
  { id: "todo", label: "To do" },
  { id: "in-progress", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "closed", label: "Closed" },
] as const;

export function dashboardColumnFor(status: string): (typeof dashboardColumns)[number]["id"] {
  if (status === "succeeded") return "done";
  if (status === "cancelled") return "closed";
  if (["running", "pausing", "paused", "cancelling"].includes(status)) return "in-progress";
  return "todo";
}
