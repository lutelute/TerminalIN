const BASE = "http://127.0.0.1:37123/api";

export interface SnappedWindow {
  windowNumber: number;
  app: string;
  title: string;
  slot: number;
}

export interface Workspace {
  id: number;
  name: string;
  gridCols: number;
  gridRows: number;
  snapped: SnappedWindow[];
  gridTerminals: number;
}

export interface StatusResponse {
  ok: boolean;
  version: string;
  workspaces: Workspace[];
}

export interface WindowInfo {
  windowNumber: number;
  app: string;
  title: string;
  pid: number;
}

async function call<T>(method: string, path: string, body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`TiN API ${res.status}`);
  return res.json() as Promise<T>;
}

export function getStatus() {
  return call<StatusResponse>("GET", "/status");
}

export function getWindows() {
  return call<{ ok: boolean; windows: WindowInfo[] }>("GET", "/windows");
}

export function snapWindow(opts?: { windowNumber?: number; workspaceId?: number }) {
  return call<{ ok: boolean; slot?: number; workspaceId?: number; note?: string }>("POST", "/snap", opts || {});
}

export function unsnapWindow(opts?: { windowNumber?: number }) {
  return call<{ ok: boolean; error?: string }>("POST", "/unsnap", opts || {});
}

export function focusTiN() {
  return call<{ ok: boolean }>("POST", "/focus");
}
