export type DesktopWindow = {
  id: string;
  title: string;
  accessible: boolean;
  instance?: string;
};

export interface ComputerDriver {
  permissions(root: string, signal: AbortSignal): Promise<Record<string, string>>;
  windows(root: string, app: string, signal: AbortSignal): Promise<DesktopWindow[]>;
  snapshot(root: string, app: string, signal: AbortSignal, windowId?: string):
    Promise<{ tree: unknown; windowId?: string; pid?: number }>;
  screenshot(root: string, app: string, windowId: string, path: string, signal: AbortSignal): Promise<void>;
  click(root: string, reference: string, signal: AbortSignal): Promise<void>;
}
