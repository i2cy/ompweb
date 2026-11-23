// Main's side of upload retention (docs/specs/2026-11-02-file-uploads-design.md, U6): every daemon is told the
// `uploadRetentionDays` setting when it links and when the setting changes. No `next/*` or `@/` imports.
import { loadWebServerSettings } from "../web-settings";
import { getHost, listHosts, onHostHello, setHostUploadRetention } from "./hub";
import { isLinkUp } from "./host";
import { HostOpError } from "./link-protocol";
import { LOCAL_HOST_ID } from "./registry";

function send(hostId: string, days: number | null, delay = 1_000): void {
  // Nothing awaits it, and an unhandled rejection stops the server (instrumentation.node.ts).
  setHostUploadRetention(hostId, days).catch((error: unknown) => {
    // 501: a daemon from before the op keeps what it has. 503: offline, the next hello tells it.
    if (error instanceof HostOpError && (error.status === 501 || error.status === 503)) return;
    console.warn(`[omp-web] could not set the upload retention on host ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
    // Deliberately ref'd: the retry must fire even when nothing else keeps
    // the event loop alive. An unref'd timer was observed to be lost on
    // Windows CI (issue #536: "the current policy to retry" never arrived),
    // leaving the daemon on a superseded policy until the next hello or
    // change. The callback re-checks the link and the current setting, so a
    // late fire is harmless, and it never re-arms after disconnect.
    setTimeout(() => {
      const host = getHost(hostId);
      // A pending retry must never restore an older, potentially more destructive setting.
      if (host && isLinkUp(host.status()) && loadWebServerSettings().uploadRetentionDays === days) {
        send(hostId, days, Math.min(delay * 2, 30_000));
      }
    }, delay);
  });
}

/** The setting changed: tell this machine's daemon and every linked host's. */
export function pushUploadRetention(days: number | null): void {
  for (const hostId of [LOCAL_HOST_ID, ...listHosts().map((host) => host.id)]) send(hostId, days);
}

/** Tell already-linked hosts, then every daemon that says hello, the current setting. Returns the unsubscribe. */
export function startUploadRetentionSync(): () => void {
  const unsubscribe = onHostHello((hostId) => send(hostId, loadWebServerSettings().uploadRetentionDays));
  pushUploadRetention(loadWebServerSettings().uploadRetentionDays);
  return unsubscribe;
}
