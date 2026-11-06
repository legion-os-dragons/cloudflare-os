import { useEffect, useState } from "react";
import type { RpcStub } from "capnweb";
import type {
  CollaboratorRole,
  WorkspaceConnectionAccess,
  WorkspaceConnectionAccessView,
} from "@gadgets/workshop-shared/api";
import { WorkshopButton } from "../../components/WorkshopControls";

type Props = {
  getManager: () => Promise<RpcStub<WorkspaceConnectionAccess>>;
  managePeople?: boolean;
};

export const WorkspaceAccessPanel = ({ getManager, managePeople = false }: Props) => {
  const [manager, setManager] = useState<{ api: RpcStub<WorkspaceConnectionAccess> } | null>(null);
  const [view, setView] = useState<WorkspaceConnectionAccessView | null>(null);
  const [person, setPerson] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CollaboratorRole>("use");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let held: RpcStub<WorkspaceConnectionAccess> | undefined;
    const release = () => {
      held?.[Symbol.dispose]();
      held = undefined;
    };
    setManager(null);
    setView(null);
    setError("");
    void getManager()
      .then(async (api) => {
        held = api;
        if (cancelled) {
          release();
          return;
        }
        const next = await api.getView();
        if (!cancelled) {
          setManager({ api });
          setView(next);
          setPerson(next.people[0]?.profile.id ?? "");
        }
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : "Access settings could not be loaded.");
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [getManager]);
  const act = async (operation: () => Promise<WorkspaceConnectionAccessView>, message: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await operation();
      setView(next);
      setNotice(message);
      if (!next.people.some((entry) => entry.profile.id === person))
        setPerson(next.people[0]?.profile.id ?? "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The change did not complete. Refresh to check current access.",
      );
    } finally {
      setBusy(false);
    }
  };
  const grantAll = async () => {
    if (!manager || !view || !person) return;
    await act(async () => {
      let next = view;
      for (const connection of view.connections.filter(
        (item) => item.delegatable && !item.grantedTo.includes(person),
      )) {
        next = await manager.api.setConnectionAccess(person, connection.id, true, next.revision);
        setView(next);
      }
      return next;
    }, "Connection access saved.");
  };
  return (
    <section
      aria-label="Workspace connection access"
      className="my-4 rounded-xl border border-kumo-line bg-kumo-base p-4 text-kumo-default"
    >
      <h3 className="text-base font-semibold">Connection access</h3>
      <WorkshopButton
        type="button"
        disabled={busy || !manager}
        onClick={() => {
          if (manager) void act(() => manager.api.getView(), "Access refreshed.");
        }}
      >
        Refresh access
      </WorkshopButton>
      <p className="my-2 text-sm text-kumo-subtle">
        Choose which connected data sources each workspace member can use. Your credentials stay
        private. Existing approvals for changes still apply.
      </p>
      {error && (
        <p role="alert" className="my-2 text-sm text-kumo-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="my-2 text-sm">
          {notice}
        </p>
      )}
      {!view && !error && <p role="status">Loading access settings…</p>}
      {view && (
        <>
          <p className="mb-3 text-xs text-kumo-subtle">Owner: {view.ownerProfileId}</p>
          {managePeople && (
            <form
              className="my-3 flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (manager)
                  void act(
                    () => manager.api.invitePerson(email.trim().toLowerCase(), role),
                    "Workspace access saved.",
                  );
              }}
            >
              <label className="flex-1 text-sm">
                Person’s email
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="mt-1 block w-full rounded-lg border border-kumo-line bg-kumo-base p-2"
                />
              </label>
              <label className="text-sm">
                Workspace role
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value as CollaboratorRole)}
                  className="mt-1 block rounded-lg border border-kumo-line bg-kumo-base p-2"
                >
                  <option value="use">Gadget access</option>
                  <option value="build">Full workspace access</option>
                </select>
              </label>
              <WorkshopButton type="submit" disabled={busy}>
                Grant workspace access
              </WorkshopButton>
            </form>
          )}
          <label className="block text-sm">
            Workspace member
            <select
              value={person}
              disabled={busy}
              onChange={(event) => {
                setPerson(event.target.value);
                setConfirmRemove(false);
                setNotice("");
              }}
              className="my-2 block w-full rounded-lg border border-kumo-line bg-kumo-base p-2"
            >
              {!view.people.length && <option value="">Invite a person first</option>}
              {view.people.map((entry) => (
                <option key={entry.profile.id} value={entry.profile.id}>
                  {entry.profile.id} —{" "}
                  {entry.role === "build" ? "Full workspace access" : "Gadget access"}
                </option>
              ))}
            </select>
          </label>
          {person && (
            <>
              <ul className="divide-y divide-kumo-line">
                {view.connections.map((connection) => {
                  const allowed = connection.grantedTo.includes(person);
                  return (
                    <li
                      key={connection.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{connection.title}</p>
                        <p className="break-all text-xs text-kumo-subtle">
                          {connection.resourceUrl}
                        </p>
                        <p className="text-xs">
                          {allowed
                            ? "Access granted"
                            : connection.delegatable
                              ? "Not granted"
                              : "Requires this person’s own provider account"}
                        </p>
                      </div>
                      {connection.delegatable && (
                        <WorkshopButton
                          type="button"
                          disabled={busy || !manager}
                          aria-label={`${allowed ? "Revoke" : "Grant"} ${connection.title} access for ${person}`}
                          onClick={() => {
                            if (manager)
                              void act(
                                () =>
                                  manager.api.setConnectionAccess(
                                    person,
                                    connection.id,
                                    !allowed,
                                    view.revision,
                                  ),
                                allowed
                                  ? "Connection access revoked. Active sessions will reconnect."
                                  : "Connection access granted.",
                              );
                          }}
                        >
                          {allowed ? "Revoke access" : "Grant access"}
                        </WorkshopButton>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!view.connections.length && (
                <p className="my-2 text-sm">This workspace has no account-requiring connections.</p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <WorkshopButton
                  type="button"
                  disabled={
                    busy ||
                    !view.connections.some(
                      (item) => item.delegatable && !item.grantedTo.includes(person),
                    )
                  }
                  onClick={() => void grantAll()}
                >
                  Grant supported connections
                </WorkshopButton>
                <WorkshopButton
                  type="button"
                  disabled={busy || !manager}
                  onClick={async () => {
                    if (!manager) return;
                    setBusy(true);
                    setError("");
                    setNotice("");
                    try {
                      const result = await manager.api.checkPersonAccess(person);
                      if (result.ready) setNotice(result.message);
                      else setError(result.message);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : "Access could not be checked.",
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Check access
                </WorkshopButton>
                {managePeople && (
                  <WorkshopButton
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmRemove(true)}
                  >
                    Remove workspace access
                  </WorkshopButton>
                )}
              </div>
              {confirmRemove && (
                <div
                  role="group"
                  aria-label="Confirm removing workspace access"
                  className="mt-3 rounded-lg border border-kumo-line p-3"
                >
                  <p className="mb-2 text-sm">
                    Remove {person} from this workspace and revoke their connection grants?
                  </p>
                  <WorkshopButton
                    disabled={busy}
                    onClick={() => {
                      if (manager)
                        void act(
                          () => manager.api.removePerson(person),
                          "Workspace access removed.",
                        );
                    }}
                  >
                    Confirm removal
                  </WorkshopButton>
                  <WorkshopButton disabled={busy} onClick={() => setConfirmRemove(false)}>
                    Cancel
                  </WorkshopButton>
                </div>
              )}
            </>
          )}
          <details className="mt-4 text-xs">
            <summary>Access history</summary>
            <ul className="mt-2 space-y-2">
              {view.audit.map((item) => (
                <li key={item.id}>
                  {new Date(item.at).toLocaleString()} · {item.actor} · {item.action} ·{" "}
                  {item.profileId}
                  {item.connectionId !== null
                    ? ` · ${view.connections.find((connection) => connection.id === item.connectionId)?.title ?? "Removed connection"}`
                    : ""}
                </li>
              ))}
            </ul>
            {!view.audit.length && <p>No access changes recorded yet.</p>}
          </details>
        </>
      )}
    </section>
  );
};
