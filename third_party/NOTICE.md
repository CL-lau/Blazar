# Upstream code

- T3 Code at `2c4310eb061373bb1c6ccefe6dafd0500ee8f5e3`. The Git numstat parser in `services/device/execution/git-numstat.ts` comes from `apps/server/src/checkpointing/Diffs.ts`. [MIT license](licenses/t3code-MIT.txt)
- Linger at `c7afe5e9eb3625d801cf37987696ffbc0f9dc5ab`. Blazar's `services/router/model-queue.ts` adapts the admission and cancellation logic from `apps/node-services/src/agent/runner-gateway/model-queue.ts` to a single slot per configured Router model. [Linger license](licenses/linger.txt)
- Linger at `d4dd925502d4540788a31a8f43ac97996a3c29c7`. The desktop application catalog adapts `apps/web/src/features/apps/app-groups.ts` and `connection-state.ts`, and the board adapts `apps/web/src/features/work-items/work-items-page.tsx` for Blazar's Router. Copyright © 2026 SIMPLEX AI TECHNOLOGIES PTE. LTD. [Linger license](../apps/desktop/public/third-party/Linger.txt)
- T3 Code at `0591d328`. The desktop sidebar uses `apps/web/src/components/threadSidebarWidth.ts` and adapts `apps/web/src/components/DiffPanelShell.tsx`, along with the existing text truncation components. [MIT license](../apps/desktop/public/third-party/T3-Code.txt)
