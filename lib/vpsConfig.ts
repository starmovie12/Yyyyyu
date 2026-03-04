/**
 * lib/vpsConfig.ts
 *
 * Hardcoded VPS API configuration.
 * HubCloud API: http://85.121.5.246:5001
 * Timer API:    http://85.121.5.246:10000
 */

export interface VpsConfig {
  vpsBaseUrl:    string;
  hubcloudPort:  string;
  timerPort:     string;
}

export interface ResolvedVpsConfig {
  config:       VpsConfig;
  hubcloudApi:  string;   // full URL: "http://85.121.5.246:5001"
  timerApi:     string;   // full URL: "http://85.121.5.246:10000"
}

// ─── Hardcoded API config ─────────────────────────────────────────────────────
const FIXED_CONFIG: VpsConfig = {
  vpsBaseUrl:   'http://85.121.5.246',
  hubcloudPort: '5001',
  timerPort:    '10000',
};

function resolve(cfg: VpsConfig): ResolvedVpsConfig {
  const cleanBaseUrl = cfg.vpsBaseUrl.replace(/\/+$/, '');
  return {
    config:      cfg,
    hubcloudApi: `${cleanBaseUrl}:${cfg.hubcloudPort}`,   // http://85.121.5.246:5001
    timerApi:    `${cleanBaseUrl}:${cfg.timerPort}`,       // http://85.121.5.246:10000
  };
}

/**
 * Returns hardcoded VPS API URLs.
 * HubCloud: http://85.121.5.246:5001
 * Timer:    http://85.121.5.246:10000
 */
export async function getVpsConfig(): Promise<ResolvedVpsConfig> {
  console.log('[VPS Config] Using fixed config — HubCloud: http://85.121.5.246:5001 | Timer: http://85.121.5.246:10000');
  return resolve(FIXED_CONFIG);
}

/** No-op kept for compatibility */
export function invalidateVpsConfigCache(): void {}

export { FIXED_CONFIG as VPS_DEFAULTS };
