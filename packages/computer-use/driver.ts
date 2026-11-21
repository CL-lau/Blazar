export type DesktopWindow = {
  id: string;
  title: string;
  accessible: boolean;
  instance?: string;
};

export type DesktopElement = {
  role?: string;
  name?: string;
  pressReference?: string;
  children: DesktopElement[];
};

export type DesktopSnapshot = {
  tree: DesktopElement;
  // Identifies the observed state independently of transient action references.
  fingerprint: string;
  windowId?: string;
  pid?: number;
};

export interface ComputerDriver {
  permissions(root: string, signal: AbortSignal): Promise<Record<string, string>>;
  windows(root: string, app: string, signal: AbortSignal): Promise<DesktopWindow[]>;
  snapshot(root: string, app: string, signal: AbortSignal, windowId?: string): Promise<DesktopSnapshot>;
  screenshot(root: string, app: string, windowId: string, path: string, signal: AbortSignal): Promise<void>;
  click(root: string, reference: string, signal: AbortSignal): Promise<void>;
}
