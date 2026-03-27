// ── Admin types ───────────────────────────────────────────

export interface PoolStatus {
  total: number;
  warm: number;
  active: number;
  creating: number;
  deleting: number;
  deleted: number;
  warm_pool_size: number;
  max_total: number;
  utilization: number;
  warm_ratio: number;
  healthy: boolean;
  health_message?: string;
  last_scale_at?: string;
  last_allocate_at?: string;
}

export interface RollingStatus {
  id?: string;
  phase: string;
  target_image?: string;
  progress: number;
  warm_total: number;
  warm_updated: number;
  active_total: number;
  active_updated: number;
  started_at?: string;
  completed_at?: string;
  duration?: string;
  message?: string;
  error?: string;
}

export interface RollingStartOptions {
  /** Target image to roll out (required). */
  image: string;
}
