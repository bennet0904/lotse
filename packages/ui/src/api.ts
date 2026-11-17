/** Client for the builder server's API. The UI talks to nothing else. */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiErrorBody {
  code: string;
  message: string;
  hints: string[];
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message);
  }
  get code(): string {
    return this.body.code;
  }
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: "same-origin",
    headers: { "x-requested-with": "lotse", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const error = (parsed as { error?: ApiErrorBody } | undefined)?.error ?? {
      code: "INTERNAL",
      message: `The server answered with HTTP ${res.status}.`,
      hints: [],
    };
    throw new ApiError(res.status, error);
  }
  return parsed as T;
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T>(path: string, body: unknown = {}) => api<T>("POST", path, body);

// --- types of the API ---------------------------------------------------------

export interface User {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export interface Plan {
  stack: string;
  name: string;
  title: string;
  summary: string;
  dataModel: { entity: string; fields: string[] }[];
  pages: { name: string; purpose: string }[];
  resources: string[];
  notes: string[];
}

export interface Project {
  id: string;
  name: string;
  title: string;
  stack: string | null;
  status: "planning" | "planned" | "generating" | "ready" | "failed";
  prompt: string;
  plan: Plan | null;
  target: { adapter: string; accountId: string } | null;
  git: { provider: string; accountId: string; repo: { owner: string; name: string; url: string } } | null;
  previewUrl: string;
  updatedAt: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  meta: { kind?: string; plan?: Plan; changedFiles?: string[]; proposals?: { action: string; summary: string }[]; verified?: boolean; url?: string } | null;
  createdAt: number;
}

export interface Job {
  id: string;
  type: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  error: string | null;
  result: Record<string, unknown> | null;
}

export interface JobEvent {
  seq: number;
  at: number;
  data: { kind: "agent" | "deploy" | "log" | "status" | "error"; [key: string]: unknown };
}

export interface TokenSetup {
  url: string;
  permissions: string[];
  steps: string[];
  fields?: { name: string; label: string; required: boolean; placeholder?: string; help?: string }[];
}

export interface AdapterInfo {
  id: string;
  name: string;
  auth: ("oauth" | "token" | "ssh")[];
  tokenSetup: TokenSetup | null;
  capabilities?: { runtimes: string[]; languages: string[]; resources: string[]; customDomains: boolean; previewDeployments: boolean; rollback: string };
  serverSetup?: boolean;
  backups?: boolean;
  resources?: string[];
}

export interface Adapters {
  hosting: AdapterInfo[];
  git: AdapterInfo[];
  resources: AdapterInfo[];
}

export interface Account {
  id: string;
  adapter: string;
  kind: "hosting" | "git" | "resource";
  label: string;
  scope: "user" | "team";
  account: string;
  method: string;
  mine: boolean;
}

export interface DeployPlan {
  adapter: string;
  app: string;
  firstDeployment: boolean;
  steps: { id: string; title: string; detail?: string; action: string }[];
  warnings: string[];
  missingSecrets: string[];
}

export interface SetupPlan {
  host: string;
  os: { name: string; arch: string; supported: boolean };
  steps: { id: string; title: string; changes: string[]; needed: boolean; skipped?: string }[];
  warnings: string[];
}

// --- live job events over WebSocket -------------------------------------------

export interface JobStream {
  events: JobEvent[];
  job: Job | null;
  running: boolean;
}

/** Follows a job: stored events are replayed, new ones arrive live. Reconnects without losing events. */
export function useJob(jobId: string | null | undefined, onDone?: (job: Job) => void): JobStream {
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    setEvents([]);
    setJob(null);
    if (!jobId) return;
    let closed = false;
    let socket: WebSocket | undefined;
    let last = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/ws`);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "subscribe", jobId, after: last }));
      socket.onmessage = (message) => {
        const data = JSON.parse(String(message.data)) as { type: string; seq?: number; at?: number; data?: JobEvent["data"]; job?: Job };
        if (data.type === "event" && data.seq && data.seq > last) {
          last = data.seq;
          setEvents((list) => [...list, { seq: data.seq as number, at: data.at as number, data: data.data as JobEvent["data"] }]);
        } else if (data.type === "done" && data.job) {
          closed = true;
          setJob(data.job);
          done.current?.(data.job);
          socket?.close();
        }
      };
      socket.onclose = () => {
        if (!closed) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [jobId]);

  return { events, job, running: Boolean(jobId) && !job };
}

/** Loads data and keeps a way to reload it. */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[],
): { data: T | undefined; error: ApiError | undefined; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller lists what the loader depends on
  useEffect(() => {
    let current = true;
    setLoading(true);
    load().then(
      (value) => {
        if (!current) return;
        setData(value);
        setError(undefined);
        setLoading(false);
      },
      (err) => {
        if (!current) return;
        setError(err instanceof ApiError ? err : new ApiError(0, { code: "NETWORK", message: String(err?.message ?? err), hints: [] }));
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
