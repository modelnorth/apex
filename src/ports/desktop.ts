export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export type DesktopPermissionState = 'granted' | 'denied' | 'not_required' | 'unknown';

export interface DesktopStatus {
  ok: boolean;
  platform: DesktopPlatform;
  accessibility: DesktopPermissionState;
  interactiveSession: boolean;
  version?: string;
  stateRoot?: string;
  error?: string;
}

export interface DesktopApp {
  name: string;
  bundleId?: string;
  pid?: number;
}

export interface DesktopWindow {
  id: string;
  title: string;
  app: string;
  bounds?: { x: number; y: number; width: number; height: number };
  focused?: boolean;
}

export interface DesktopNode {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  states?: string[];
  children?: DesktopNode[];
}

export interface DesktopSnapshotOptions {
  app?: string;
  rootRef?: string;
  interactiveOnly?: boolean;
  compact?: boolean;
  skeleton?: boolean;
  session?: string;
  timeoutMs?: number;
}

export interface DesktopSnapshotResult {
  ok: boolean;
  snapshotId?: string;
  tree?: DesktopNode;
  rawJson?: string;
  error?: { code: string; message: string; retrySafe: boolean };
}

export interface DesktopActionOptions {
  session?: string;
  headed?: boolean;
  timeoutMs?: number;
}

export interface DesktopActionResult {
  ok: boolean;
  action: string;
  targetRef?: string;
  disposition?: { delivery: string; retry: 'safe' | 'unsafe' | 'terminal' };
  error?: { code: string; message: string; retrySafe: boolean };
}

export interface DesktopPort {
  status(signal?: AbortSignal): Promise<DesktopStatus>;
  listApps(signal?: AbortSignal): Promise<DesktopApp[]>;
  listWindows(app?: string, signal?: AbortSignal): Promise<DesktopWindow[]>;
  snapshot(options?: DesktopSnapshotOptions, signal?: AbortSignal): Promise<DesktopSnapshotResult>;
  click(
    ref: string,
    options?: DesktopActionOptions & { doubleClick?: boolean; rightClick?: boolean },
    signal?: AbortSignal,
  ): Promise<DesktopActionResult>;
  type(
    ref: string,
    text: string,
    options?: DesktopActionOptions,
    signal?: AbortSignal,
  ): Promise<DesktopActionResult>;
  press(
    keyCombo: string,
    options?: DesktopActionOptions,
    signal?: AbortSignal,
  ): Promise<DesktopActionResult>;
  focusWindow(windowIdOrTitle: string, signal?: AbortSignal): Promise<DesktopActionResult>;
  launch(appName: string, signal?: AbortSignal): Promise<DesktopActionResult>;
}
