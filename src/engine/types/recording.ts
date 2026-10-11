export interface RecordedFrame {
  timestamp: string;
  direction: "request" | "response";
  method: string;
  sessionId?: string;
  payload: unknown;
}

export interface Recording {
  id: string;
  createdAt: string;
  targetTransport: string;
  redactionProfile: "default";
  frames: RecordedFrame[];
}

export type ReplayMode = "as-recorded" | "max-rate" | "paced";

export interface ReplayOptions {
  recordingPath: string;
  mode: ReplayMode;
  paceMs?: number;
  target?: {
    transport: string;
    command?: string;
    args?: string[];
    url?: string;
  };
}
