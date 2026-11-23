"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SessionInfo } from "@/lib/types";

/** One open session tab: the session id plus its host (sessions on different hosts can share ids). */
export interface SessionTab {
  id: string;
  hostId?: string;
}

const REFRESH_MS = 15_000;

function tabKey(tab: SessionTab): string {
  return `${tab.hostId ?? "local"}:${tab.id}`;
}

function sessionTitle(session: SessionInfo, untitled: string): string {
  const name = session.name?.trim();
  if (name) return name;
  const first = session.firstMessage?.trim();
  if (first && first !== "(no messages)") return first;
  return untitled;
}

/**
 * Tab strip above the chat for sessions opened this browser: click a tab to
 * switch to it, × to close the tab (the session itself is untouched — it
 * stays in the sidebar). Titles, running state and input-waiting state come
 * from the same `/api/sessions` list the sidebar reads.
 *
 * Minimal scope: switching remounts the chat (like picking a session in the
 * sidebar), so per-tab scroll position is not preserved yet.
 */
export function SessionTabs({ tabs, selectedId, onSelect, onClose }: {
  tabs: SessionTab[];
  selectedId: string | null;
  onSelect: (session: SessionInfo) => void;
  /** Close a tab; `next` is the neighbour to show when the selected tab closes, or null when none remains. */
  onClose: (tab: SessionTab, next: SessionInfo | null) => void;
}) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [awaitingIds, setAwaitingIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok || cancelled) return;
        const data = await res.json() as { sessions?: SessionInfo[]; runningSessionIds?: string[]; runningSessions?: Array<{ id: string; awaitingInput?: boolean }> };
        if (cancelled) return;
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
        setRunningIds(new Set(data.runningSessionIds ?? []));
        setAwaitingIds(new Set((data.runningSessions ?? []).filter((entry) => entry.awaitingInput).map((entry) => entry.id)));
      } catch {
        // Keep the last good list; the sidebar owns the load error state.
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (tabs.length === 0) return null;
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // A tab whose session the list no longer knows (deleted elsewhere) drops
  // off, except the selected one, which keeps its place until navigation moves on.
  const visible = tabs.filter((tab) => byId.has(tab.id) || tab.id === selectedId);
  if (visible.length === 0) return null;

  const closeTab = (tab: SessionTab) => {
    let next: SessionInfo | null = null;
    if (tab.id === selectedId) {
      const idx = visible.findIndex((entry) => tabKey(entry) === tabKey(tab));
      const neighbour = visible[idx - 1] ?? visible[idx + 1] ?? null;
      next = neighbour ? byId.get(neighbour.id) ?? null : null;
    }
    onClose(tab, next);
  };

  return (
    <div
      role="tablist"
      aria-label={t("sessionTabs.tabsLabel")}
      style={{
        display: "flex", alignItems: "stretch", gap: 4,
        padding: "6px 12px 0", overflowX: "auto", flexShrink: 0,
      }}
    >
      {visible.map((tab) => {
        const session = byId.get(tab.id);
        const title = session ? sessionTitle(session, t("sessionTabs.untitledSession")) : tab.id;
        const selected = tab.id === selectedId;
        const running = runningIds.has(tab.id);
        const awaitingInput = awaitingIds.has(tab.id);
        return (
          <div
            key={tabKey(tab)}
            style={{
              display: "flex", alignItems: "center", flexShrink: 0,
              maxWidth: 220, minWidth: 0,
              background: selected ? "var(--bg-panel)" : "transparent",
              border: "1px solid var(--border)",
              borderBottom: selected ? "1px solid var(--bg-panel)" : "1px solid var(--border)",
              borderRadius: "8px 8px 0 0",
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={!session}
              onClick={() => { if (session) onSelect(session); }}
              title={awaitingInput ? t("sessionTabs.awaitingInput") : running ? t("sessionTabs.running") : title}
              style={{
                display: "flex", alignItems: "center", gap: 6,
                minWidth: 0, flex: 1,
                height: 30, padding: "0 4px 0 10px",
                background: "none", border: "none",
                color: selected ? "var(--text)" : "var(--text-muted)",
                cursor: session ? "pointer" : "default",
                fontSize: 12, fontWeight: selected ? 600 : 400,
                textAlign: "left",
              }}
            >
              {(running || awaitingInput) && (
                <span
                  aria-hidden
                  className={running && !awaitingInput ? "live-status-dot live-pulse inline-block h-2 w-2 shrink-0 rounded-full bg-accent" : undefined}
                  style={awaitingInput
                    ? { flexShrink: 0, width: 8, height: 8, borderRadius: "50%", background: "var(--status-warning)" }
                    : { flexShrink: 0 }}
                />
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); closeTab(tab); }}
              title={t("sessionTabs.closeTab", { title })}
              aria-label={t("sessionTabs.closeTab", { title })}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 22, height: 22, marginRight: 4, padding: 0, flexShrink: 0,
                background: "none", border: "none", borderRadius: 5,
                color: "var(--text-dim)", cursor: "pointer",
              }}
            >
              <X size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
