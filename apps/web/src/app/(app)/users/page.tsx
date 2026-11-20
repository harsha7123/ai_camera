"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { RequirePermission } from "@/components/AdminOnly";
import { EmptyState, ErrorState, Loading, PageHeader, Skeleton } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { ROLE_LABEL } from "@/lib/present";
import { useApp } from "@/lib/store";
import type { Role, User, UserUpdate } from "@/lib/types";

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: "staff", label: ROLE_LABEL.staff, hint: "Area status and acknowledging alerts" },
  { value: "manager", label: ROLE_LABEL.manager, hint: "Plus clips, dispositions, traffic and the access log" },
  { value: "owner", label: ROLE_LABEL.owner, hint: "Plus shadow-mode incidents and legal holds" },
  { value: "admin", label: ROLE_LABEL.admin, hint: "Cameras, users, audit; no clip access" },
];
const roleLabel = (r: Role) => ROLE_LABEL[r] ?? r;
const MIN_PASSWORD = 12;

function CreateUser({ onCreated }: { onCreated: (u: User) => void }) {
  const [f, setF] = useState({ username: "", display_name: "", role: "staff" as Role, password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const userErr = f.username && !/^[a-z0-9._-]{2,32}$/.test(f.username) ? "Use 2–32 characters: lowercase letters, digits, . _ -" : null;
  const pwErr = f.password && f.password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters` : null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setOk(null);
    if (!f.username || !f.password || userErr || pwErr) {
      setError("Fill in username and a password of at least 12 characters.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const u = await api.post<User>("/api/v1/users", { ...f, display_name: f.display_name.trim() || f.username });
      onCreated(u);
      setOk(`Account “${u.username}” created as ${roleLabel(u.role)}. Share the password in person.`);
      setF({ username: "", display_name: "", role: "staff", password: "" });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} noValidate aria-labelledby="new-user-h" data-testid="user-form">
      <h2 id="new-user-h">Add an account</h2>
      <label className="field">
        <span>
          Username <span className="req">(required)</span>
        </span>
        <input name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} aria-invalid={userErr ? true : undefined} aria-describedby="u-hint" />
        <span id="u-hint" className={userErr ? "field-error" : "muted small"}>
          {userErr ?? "Lowercase, used to sign in"}
        </span>
      </label>
      <label className="field">
        <span>Display name</span>
        <input name="display_name" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} />
      </label>
      <fieldset className="field">
        <legend>Role</legend>
        <div className="radio-grid">
          {ROLES.map((r) => (
            <label key={r.value} className={`radio-card${f.role === r.value ? " is-checked" : ""}`}>
              <input type="radio" name="role" value={r.value} checked={f.role === r.value} onChange={() => setF({ ...f, role: r.value })} />
              <span>
                <span className="radio-label">{r.label}</span>
                <span className="muted small">{r.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span>
          Initial password <span className="req">(required)</span>
        </span>
        <input name="password" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} aria-invalid={pwErr ? true : undefined} aria-describedby="pw-hint" />
        <span id="pw-hint" className={pwErr ? "field-error" : "muted small"}>
          {pwErr ?? `At least ${MIN_PASSWORD} characters`}
        </span>
      </label>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="notice notice-info" role="status">
          {ok}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={busy} data-testid="user-submit">
        {busy ? "Creating…" : "Create account"}
      </button>
    </form>
  );
}

/** Role change, password reset and disable/enable for one account (POST /users/{id}). */
function EditUser({ user, self, onSaved, onClose }: { user: User; self: boolean; onSaved: (u: User) => void; onClose: () => void }) {
  const [role, setRole] = useState<Role>(user.role);
  const [password, setPassword] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const pwErr = password && password.length < MIN_PASSWORD ? `At least ${MIN_PASSWORD} characters` : null;

  const save = async (patch: UserUpdate, done: (u: User) => string) => {
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const u = await api.post<User>(`/api/v1/users/${user.id}`, patch);
      onSaved(u);
      setOk(done(u));
      setConfirmDisable(false);
      setPassword("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="edit-user-h" data-testid="user-edit">
      <div className="card-head">
        <h2 id="edit-user-h">
          Manage {user.display_name} <code className="small">{user.username}</code>
        </h2>
        <button type="button" className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="muted small">Changing the role or password, or disabling the account, signs this person out on every device.</p>
      {self ? <p className="notice notice-info small">This is your own account. You cannot disable it or change your own role.</p> : null}

      <form
        className="edit-block"
        onSubmit={(e) => {
          e.preventDefault();
          void save({ role }, (u) => `Role changed to ${roleLabel(u.role)}.`);
        }}
      >
        <label className="field">
          <span>Role</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={self || busy} data-testid="edit-role">
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label} — {r.hint}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-secondary" disabled={self || busy || role === user.role} data-testid="edit-role-save">
          Change role
        </button>
      </form>

      <form
        className="edit-block"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (password.length < MIN_PASSWORD) {
            setError(`The new password needs at least ${MIN_PASSWORD} characters.`);
            return;
          }
          void save({ password }, () => "Password reset. Share it in person; the old password no longer works.");
        }}
      >
        <label className="field">
          <span>New password</span>
          <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={pwErr ? true : undefined} aria-describedby="reset-pw-hint" data-testid="edit-password" />
          <span id="reset-pw-hint" className={pwErr ? "field-error" : "muted small"}>
            {pwErr ?? `At least ${MIN_PASSWORD} characters`}
          </span>
        </label>
        <button type="submit" className="btn btn-secondary" disabled={busy || !password} data-testid="edit-password-save">
          Reset password
        </button>
      </form>

      <div className="edit-block">
        {user.disabled ? (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void save({ disabled: false }, () => "Account enabled. The person can sign in again.")} data-testid="edit-enable">
            Enable account
          </button>
        ) : confirmDisable ? (
          <div className="confirm-row" role="group" aria-label="Confirm disabling the account" data-testid="disable-confirm">
            <p>
              Disable {user.display_name}? They are signed out everywhere and cannot sign in until an administrator enables the account again. Their past actions stay in the audit log.
            </p>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save({ disabled: true }, () => "Account disabled and signed out everywhere.")} data-testid="disable-yes">
              {busy ? "Disabling…" : "Disable account"}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirmDisable(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-secondary" disabled={self || busy} onClick={() => setConfirmDisable(true)} data-testid="edit-disable">
            Disable account…
          </button>
        )}
      </div>

      {error ? (
        <p className="notice notice-error" role="alert" data-testid="edit-error">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="notice notice-info" role="status" data-testid="edit-ok">
          {ok}
        </p>
      ) : null}
    </section>
  );
}

function UsersInner() {
  const { me } = useApp();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const load = useCallback(async () => {
    try {
      setUsers(await api.get<User[]>("/api/v1/users"));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    // Fetch-on-mount: loads from the API (an external system); state is only set after the response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const editUser = users?.find((u) => u.id === editing) ?? null;
  const replace = (u: User) => setUsers((us) => us?.map((x) => (x.id === u.id ? u : x)) ?? us);

  return (
    <>
      <PageHeader title="Users" />
      <div className="admin-grid">
        <section className="card" aria-labelledby="users-h">
          <h2 id="users-h">Accounts</h2>
          {error && !users ? (
            <ErrorState title="Accounts could not be loaded" message={error} onRetry={() => void load()} />
          ) : !users ? (
            <Loading label="Loading accounts">
              <Skeleton lines={5} height={24} />
            </Loading>
          ) : users.length === 0 ? (
            <EmptyState title="No accounts yet">Create the first account with the form.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table" data-testid="user-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Username</th>
                    <th scope="col">Role</th>
                    <th scope="col">Status</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} data-testid="user-row" data-username={u.username} data-disabled={u.disabled ? "true" : "false"}>
                      <td>{u.display_name}</td>
                      <td>
                        <code>{u.username}</code>
                      </td>
                      <td>{roleLabel(u.role)}</td>
                      <td>{u.disabled ? "Disabled" : "Active"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-small"
                          onClick={() => setEditing(u.id)}
                          aria-pressed={editing === u.id}
                          aria-label={`Manage ${u.display_name}`}
                          data-testid="user-manage"
                        >
                          Manage
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <div className="admin-side">
          {editUser ? <EditUser key={editUser.id} user={editUser} self={editUser.id === me.user.id} onSaved={replace} onClose={() => setEditing(null)} /> : null}
          <CreateUser onCreated={(u) => setUsers((us) => [...(us ?? []), u])} />
        </div>
      </div>
    </>
  );
}

export default function UsersPage() {
  return (
    <RequirePermission perm="admin">
      <UsersInner />
    </RequirePermission>
  );
}
