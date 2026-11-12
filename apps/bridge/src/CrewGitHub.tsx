import { useEffect, useState } from "react";
import { API } from "./api";

interface Access { hasToken: boolean; repo: string | null; canPush: boolean; why: string | null }

/**
 * GitHub write access for the crew: with it, SoftwareFactory's own tickets come
 * back as draft pull requests on its repo (never pushed to main). The token is
 * written to the data folder on this PC and never shown again.
 */
export function CrewGitHub() {
  const [a, setA] = useState<Access | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const call = async (body?: { token: string | null }) => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch(`${API}/api/tickets/github`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not reach the core");
      setA(j); return j as Access;
    } catch (e) { setErr((e as Error).message); return null; } finally { setBusy(false); }
  };
  useEffect(() => { call(); }, []);
  if (!a) return err ? <p className="setup-blocker">{err}</p> : null;
  const state = !a.hasToken ? "no token: the crew leaves branches on this PC" : a.canPush ? `the crew opens draft PRs on ${a.repo}` : a.why ?? "the token cannot write";
  return (
    <section className="setup-sec">
      <h3>Crew pull requests</h3>
      <div className="place">
        <div className="place-top">
          <span className="place-label">GitHub write access</span>
          <span className={`mono ${a.canPush ? "" : "muted"}`}>{busy ? "checking…" : state}</span>
          <span className="place-actions">
            <button className="ghost sm" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : a.hasToken ? "Replace" : "Add token"}</button>
            {a.hasToken && !editing && <button className="ghost sm" disabled={busy} onClick={() => call({ token: null })}>Remove</button>}
          </span>
        </div>
        {editing && <>
          <div className="place-hint">
            With this, tickets on SoftwareFactory come back as draft pull requests on its repo, and a merge closes the ticket. The crew only ever pushes its own sf/ branches, never main, and only on the real crew.
            On github.com: Settings, Developer settings, Fine-grained tokens, Generate new token. Repository access: only {a.repo ?? "SoftwareFactory"}. Permissions: Contents, Read and write; Pull requests, Read and write.
            The same token also works for Updates above. It stays on this PC and is sent only to GitHub.
          </div>
          <div className="place-edit">
            <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="github_pat_…" aria-label="GitHub write token" />
            <button className="sm" disabled={!value.trim() || busy} onClick={async () => { if (await call({ token: value })) { setEditing(false); setValue(""); } }}>Save and check</button>
          </div>
        </>}
        {err && <p className="setup-blocker">{err}</p>}
      </div>
    </section>
  );
}
