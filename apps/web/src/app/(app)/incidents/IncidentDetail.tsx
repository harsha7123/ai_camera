"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AckButton } from "@/components/AckButton";
import { Icon } from "@/components/Icon";
import { Badge, ErrorState, Loading, SeverityBadge, Skeleton } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useApp, useNow } from "@/lib/store";
import {
  DISPOSITIONS,
  DISPOSITION_LABEL,
  FAMILY_LABEL,
  LIFECYCLE_LABEL,
  STATUS_LABEL,
  durationSeconds,
  eventLabel,
  formatBytes,
  formatDateTime,
  formatTime,
  humanize,
  needsAck,
  timeOf,
} from "@/lib/present";
import type { ClipFailedEvent, ClipReadyEvent, ClipToken, Disposition, Incident } from "@/lib/types";

const ACTION_LABEL: Record<string, string> = {
  acknowledged: "Acknowledged",
  disposition: "Disposition recorded",
  escalated: "Escalated",
  legal_hold_set: "Legal hold set",
  legal_hold_released: "Legal hold released",
  merged: "Merged with another detection",
  clip_viewed: "Clip viewed",
};

// ------------------------------------------------------------------ clip player

function ClipPlayer({ incident, cameraId, onRefresh }: { incident: Incident; cameraId: string; onRefresh: () => void }) {
  const { can } = useApp();
  const clip = incident.clips?.find((c) => c.camera_id === cameraId);
  const [token, setToken] = useState<ClipToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);

  if (!can("view_clips")) {
    return (
      <div className="clip-box clip-locked" data-testid="clip-locked">
        <Icon name="lock" />
        <p>Your role cannot view clips. A manager or the owner can review this incident.</p>
      </div>
    );
  }
  if (!clip) {
    return (
      <div className="clip-box" data-testid="clip-pending">
        <p>No clip is available for this camera yet. It appears here automatically when it has been saved.</p>
        <button type="button" className="btn btn-secondary" onClick={onRefresh}>
          <Icon name="refresh" size={18} /> Check again
        </button>
      </div>
    );
  }
  if (clip.deleted_at || gone) {
    return (
      <div className="clip-box" data-testid="clip-deleted">
        <p>This clip was deleted under the retention policy{clip.deleted_at ? ` on ${formatDateTime(clip.deleted_at)}` : ""}.</p>
      </div>
    );
  }

  // A <video> error does not expose the HTTP status, and probing the media URL
  // again would be another (audited) request for the clip. Instead, re-read the
  // incident (a clip deleted under retention then shows as deleted) and explain
  // the possible causes; "Request new access" asks the token endpoint, whose
  // status (403/410/401) is reported precisely.
  const explainFailure = (t: ClipToken) => {
    onRefresh();
    if (Date.parse(t.expires_at) <= Date.now()) {
      setError("The access link has expired (links last 5 minutes).");
      return;
    }
    setError(
      "The clip could not be played. The clip may have been removed, your access may have changed, or this view could not be recorded in the audit log (playback is blocked until it can be). Request new access to try again.",
    );
  };

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      setToken(await api.post<ClipToken>(`/api/v1/clips/${encodeURIComponent(clip.id)}/token`, {}));
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) setGone(true);
      if (e instanceof ApiError && e.status === 401) setError("Your session has ended. Sign in again to view clips.");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="clip-box" data-testid="clip-player">
      {token ? (
        <>
          <video
            key={token.url}
            src={token.url}
            controls
            playsInline
            preload="metadata"
            className="clip-video"
            data-testid="clip-video"
            onError={() => explainFailure(token)}
          >
            Your browser cannot play this clip.
          </video>
          <p className="muted small">Access link valid until {formatTime(token.expires_at)}.</p>
        </>
      ) : (
        <button type="button" className="btn btn-primary" onClick={() => void request()} disabled={busy} data-testid="clip-request">
          <Icon name="camera" size={18} /> {busy ? "Requesting access…" : `Play clip · ${cameraId}`}
        </button>
      )}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}{" "}
          <button type="button" className="btn btn-small" onClick={() => void request()}>
            Request new access
          </button>
        </p>
      ) : null}
      <p className="clip-logged" data-testid="clip-logged">
        <Icon name="lock" size={16} /> Access to this clip is logged.
      </p>
      <p className="muted small">
        {clip.partial ? "Partial clip (some video was unavailable). " : ""}
        {formatTime(clip.start)} – {formatTime(clip.end)} · {formatBytes(clip.size_bytes)} · SHA-256 <code className="hash">{clip.sha256.slice(0, 12)}…</code>
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ disposition

function DispositionForm({ incident, onSaved, onConflict }: { incident: Incident; onSaved: (i: Incident) => void; onConflict: () => void }) {
  const [value, setValue] = useState<Disposition | "">("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = incident.lifecycle === "resolved";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value) {
      setError("Choose a disposition first.");
      return;
    }
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<Incident>(`/api/v1/incidents/${encodeURIComponent(incident.id)}/disposition`, { disposition: value, note: note.trim() });
      onSaved(updated);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError("Someone else resolved this incident first. Their disposition is shown above; yours was not saved.");
        onConflict();
      } else {
        setError(errorMessage(err));
      }
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-labelledby="disp-h" data-testid="disposition-form">
      <h2 id="disp-h">Disposition</h2>
      {resolved ? (
        <p className="notice notice-info" data-testid="disposition-final">
          Resolved{incident.disposition ? ` as “${DISPOSITION_LABEL[incident.disposition]}”` : ""}
          {incident.resolved_by ? ` by ${incident.resolved_by}` : ""} {incident.resolved_at ? `at ${formatTime(incident.resolved_at)}` : ""}. A disposition is final and cannot be changed.
        </p>
      ) : (
        <p className="muted small">A disposition is final once submitted. Record what you saw in the clip, not conclusions about people. Never discipline, report or deduct pay on an alert alone.</p>
      )}
      <fieldset disabled={resolved || busy}>
        <legend className="sr-only">Disposition</legend>
        <div className="radio-grid">
          {DISPOSITIONS.map((d) => (
            <label key={d.value} className={`radio-card${value === d.value ? " is-checked" : ""}`}>
              <input
                type="radio"
                name="disposition"
                value={d.value}
                checked={value === d.value}
                onChange={() => {
                  setValue(d.value);
                  setConfirming(false);
                }}
              />
              <span>
                <span className="radio-label">{d.label}</span>
                <span className="muted small">{d.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <label className="field">
          <span>Note (optional)</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="What the clip shows; POS records checked; follow-up per your policy." />
        </label>
        {error ? (
          <p className="notice notice-error" role="alert" data-testid="disposition-error">
            {error}
          </p>
        ) : null}
        {confirming ? (
          <div className="confirm-row" role="group" aria-label="Confirm disposition">
            <p>
              Submit “{value ? DISPOSITION_LABEL[value] : ""}” as the final disposition? This cannot be changed.
            </p>
            <button type="submit" className="btn btn-primary" data-testid="disposition-confirm">
              {busy ? "Submitting…" : "Confirm — submit final"}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="submit" className="btn btn-primary" data-testid="disposition-submit">
            Submit disposition
          </button>
        )}
      </fieldset>
    </form>
  );
}

// ------------------------------------------------------------------ legal hold

function LegalHold({ incident, onSaved }: { incident: Incident; onSaved: (i: Incident) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const now = useNow();
  const save = async (hold: boolean) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.post<Incident>(`/api/v1/incidents/${encodeURIComponent(incident.id)}/hold`, { hold }));
      setConfirmRelease(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  // Setting a hold is safe (it only keeps evidence longer); releasing it can make
  // the evidence eligible for deletion, so it needs a second, explicit step.
  const toggle = () => {
    if (incident.legal_hold) setConfirmRelease(true);
    else void save(true);
  };
  const deadlinePassed = timeOf(incident.retention_deadline) <= now;
  return (
    <section className="card" aria-labelledby="hold-h">
      <h2 id="hold-h">Legal hold</h2>
      <div className="switch-row">
        <button
          type="button"
          role="switch"
          aria-checked={incident.legal_hold}
          className="switch"
          onClick={toggle}
          disabled={busy || confirmRelease}
          data-testid="legal-hold"
          aria-label="Legal hold"
          aria-describedby="hold-desc"
        >
          <span className="switch-knob" aria-hidden="true" />
        </button>
        <span id="hold-desc">
          <strong aria-hidden="true">{incident.legal_hold ? "On" : "Off"}</strong> —{" "}
          {incident.legal_hold ? "evidence is kept beyond the retention deadline." : `evidence is deleted after ${formatDateTime(incident.retention_deadline)}.`}
        </span>
      </div>
      {confirmRelease ? (
        <div className="confirm-row" role="group" aria-label="Confirm releasing the legal hold" data-testid="hold-release-confirm">
          <p>
            Release the legal hold?{" "}
            {deadlinePassed
              ? "The retention deadline has already passed, so the clips can be deleted at the next retention run."
              : `The clips will then be deleted after ${formatDateTime(incident.retention_deadline)}.`}{" "}
            Only release it when the matter (claim, dispute, investigation) is closed.
          </p>
          <button type="button" className="btn btn-primary" onClick={() => void save(false)} disabled={busy} data-testid="hold-release-yes">
            {busy ? "Releasing…" : "Release legal hold"}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setConfirmRelease(false)} disabled={busy}>
            Keep the hold
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------------ detail

export function IncidentDetail({ id }: { id: string }) {
  const { can, subscribe, upsertIncident, overview } = useApp();
  const [inc, setInc] = useState<Incident | null>(null);
  const [error, setError] = useState<{ status: number; msg: string } | null>(null);
  const [camera, setCamera] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const i = await api.get<Incident>(`/api/v1/incidents/${encodeURIComponent(id)}`);
      setInc(i);
      setError(null);
    } catch (e) {
      setError({ status: e instanceof ApiError ? e.status : 0, msg: errorMessage(e) });
    }
  }, [id]);

  useEffect(() => {
    // Fetch-on-mount: loads from the API (an external system); state is only set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribe((type, data) => {
        if (type === "incident_updated" || type === "incident_merged" || type === "incident_created") {
          const d = data as Incident;
          if (d.id === id) setInc((cur) => ({ ...(cur ?? d), ...d, actions: d.actions ?? cur?.actions, clips: d.clips ?? cur?.clips }));
        } else if (type === "clip_ready" || type === "clip_failed") {
          if ((data as ClipReadyEvent | ClipFailedEvent).incident_id === id) void load();
        }
      }),
    [subscribe, id, load],
  );

  const saved = (i: Incident) => {
    setInc((cur) => ({ ...i, actions: i.actions ?? cur?.actions, clips: i.clips ?? cur?.clips }));
    upsertIncident(i);
  };

  const back = (
    <Link href="/incidents/" className="back-link pane-back">
      <Icon name="arrow-left" size={18} /> Back to inbox
    </Link>
  );

  if (error) {
    return (
      <div className="detail">
        {back}
        <ErrorState
          title={error.status === 404 ? "Incident not found" : "Incident could not be loaded"}
          message={error.status === 404 ? "It may not exist, or your role cannot see it. Return to the inbox and pick another incident." : error.msg}
          onRetry={error.status === 404 ? undefined : () => void load()}
        />
      </div>
    );
  }
  if (!inc) {
    return (
      <div className="detail">
        {back}
        <Loading label="Loading incident">
          <Skeleton lines={2} height={28} />
          <div style={{ height: 16 }} />
          <Skeleton lines={6} />
        </Loading>
      </div>
    );
  }

  const roomName = overview?.rooms.find((r) => r.id === inc.room_id)?.name ?? inc.room_id;
  const cams = inc.cameras.length ? inc.cameras : (inc.clips?.map((c) => c.camera_id) ?? []);
  const activeCam = camera && cams.includes(camera) ? camera : (cams[0] ?? null);
  const dur = durationSeconds(inc.start, inc.end);
  const timeline = [
    { at: inc.start, actor: "system", label: "Detection started", note: null as string | null },
    { at: inc.end, actor: "system", label: "Detection ended", note: null },
    ...(inc.actions ?? []).map((a) => ({
      at: a.at,
      actor: a.actor,
      label: `${ACTION_LABEL[a.action] ?? humanize(a.action)}${a.disposition ? `: ${DISPOSITION_LABEL[a.disposition] ?? a.disposition}` : ""}`,
      note: a.note,
    })),
  ].sort((a, b) => timeOf(a.at) - timeOf(b.at));

  return (
    <article className="detail" data-testid="incident-detail" data-incident={inc.id} data-lifecycle={inc.lifecycle}>
      {back}
      <header className="detail-head">
        <p className="muted small tabular">{inc.id}</p>
        <h1>{eventLabel(inc.event_type)}</h1>
        <p className="muted">
          {roomName} · {humanize(inc.room_zone)} · <span className="tabular">{formatDateTime(inc.start)}</span>
        </p>
        <div className="chips-row">
          <SeverityBadge incident={inc} />
          <span className="chip">{STATUS_LABEL[inc.status]}</span>
          <span className="chip" data-testid="detail-lifecycle">
            {LIFECYCLE_LABEL[inc.lifecycle]}
          </span>
          {inc.escalation_level > 0 ? <span className="chip chip-strong">Escalated · level {inc.escalation_level}</span> : null}
          {inc.legal_hold ? <span className="chip">Legal hold</span> : null}
          {inc.pos_ref ? (
            <span className="chip" data-testid="detail-pos-ref">
              POS ticket {inc.pos_ref}
            </span>
          ) : null}
          {inc.source === "MOCK" ? <span className="chip">Test data (mock source)</span> : null}
        </div>
      </header>

      <p className="notice notice-review" role="note" data-testid="not-a-finding">
        <Icon name="bang" size={18} /> AI flags, humans decide. This is an automated prompt for review, not a finding about any person.
      </p>

      <div className="ack-strip">
        {inc.status === "SHADOW" && inc.lifecycle === "new" ? (
          <span data-testid="shadow-info">Shadow mode: this rule is being tuned, so nobody was alerted and no acknowledgement is needed.</span>
        ) : needsAck(inc) ? (
          <>
            <span>Not yet acknowledged.</span>
            <AckButton incident={inc} onDone={saved} />
          </>
        ) : (
          <span data-testid="ack-info">
            Acknowledged{inc.acknowledged_by ? ` by ${inc.acknowledged_by}` : ""}
            {inc.acknowledged_at ? ` at ${formatTime(inc.acknowledged_at)}` : ""}.
          </span>
        )}
      </div>

      <div className="detail-grid">
        <section className="card" aria-labelledby="clip-h">
          <h2 id="clip-h">Clips</h2>
          {cams.length > 1 ? (
            <div className="segmented" role="group" aria-label="Camera">
              {cams.map((c) => (
                <button key={c} type="button" className="seg-btn" aria-pressed={c === activeCam} onClick={() => setCamera(c)}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          {activeCam ? <ClipPlayer key={activeCam} incident={inc} cameraId={activeCam} onRefresh={() => void load()} /> : <p className="muted">No cameras are linked to this incident.</p>}
        </section>

        <section className="card" aria-labelledby="ev-h" data-testid="evidence-summary">
          <h2 id="ev-h">What was detected</h2>
          <p>{inc.detail || "No description was provided by the engine."}</p>
          <dl className="kv">
            {inc.pos_ref ? (
              <>
                <dt>POS ticket</dt>
                <dd>
                  <code data-testid="pos-ref">{inc.pos_ref}</code>
                  <span className="muted small"> · check it against the POS journal before drawing conclusions</span>
                </dd>
              </>
            ) : null}
            <dt>Window</dt>
            <dd className="tabular">
              {formatTime(inc.start)} – {formatTime(inc.end)}
              {dur !== null ? ` (${dur} s)` : ""}
            </dd>
            <dt>Cameras</dt>
            <dd>{inc.cameras.join(", ") || "—"}</dd>
            <dt>Visibility</dt>
            <dd data-testid="visibility">{inc.visibility ? humanize(inc.visibility) : "Not reported — check the clip for occlusions before drawing conclusions."}</dd>
            <dt>Uncertainty</dt>
            <dd data-testid="uncertainty">{inc.uncertainty ? humanize(inc.uncertainty) : "Not reported — treat as uncertain."}</dd>
            <dt>Rule</dt>
            <dd>
              <code>{inc.rule_version}</code> (family {inc.family}
              {FAMILY_LABEL[inc.family] ? ` · ${FAMILY_LABEL[inc.family]}` : ""})
            </dd>
            <dt>Models</dt>
            <dd data-testid="model-versions">
              {Object.keys(inc.model_versions ?? {}).length
                ? Object.entries(inc.model_versions).map(([k, v]) => (
                    <span key={k} className="model-chip">
                      {k} <code>{v}</code>
                    </span>
                  ))
                : "—"}
            </dd>
            <dt>Source</dt>
            <dd>
              <code>{inc.source}</code>
            </dd>
            <dt>Retention</dt>
            <dd>{inc.legal_hold ? "On legal hold" : `Until ${formatDateTime(inc.retention_deadline)}`}</dd>
          </dl>
        </section>

        <section className="card" aria-labelledby="tl-h">
          <h2 id="tl-h">Timeline</h2>
          <ol className="timeline" data-testid="timeline">
            {timeline.map((t, k) => (
              <li key={k}>
                <span className="tl-time tabular">{formatTime(t.at)}</span>
                <span className="tl-body">
                  <strong>{t.label}</strong> <span className="muted">· {t.actor}</span>
                  {t.note ? <span className="tl-note">{t.note}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </section>

        {can("disposition") ? <DispositionForm incident={inc} onSaved={saved} onConflict={() => void load()} /> : null}
        {can("legal_hold") ? <LegalHold incident={inc} onSaved={saved} /> : null}
        {!can("disposition") && inc.lifecycle === "resolved" && inc.disposition ? (
          <section className="card">
            <h2>Disposition</h2>
            <p>
              <Badge tone="neutral" icon="check">
                {DISPOSITION_LABEL[inc.disposition]}
              </Badge>{" "}
              recorded by {inc.resolved_by ?? "a manager"}.
            </p>
          </section>
        ) : null}
      </div>
    </article>
  );
}
