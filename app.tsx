import { definePluginApp, useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { useState, useCallback } from "react";
import type { rpcContract } from "./server";

type Box = {
  id: string;
  name: string;
  state: string;
  ip: string | null;
  archiveAfter: string | null;
  setupStatus: string | null;
};

type Operation = {
  operationId: string;
  name: string;
  stage: string;
  sandboxId: string | null;
  error: string | null;
};

const stateLabel: Record<string, string> = {
  init: "Pending",
  provisioning: "Starting",
  provisioned: "Preparing",
  cloning: "Restoring",
  ready: "Ready",
  idle: "Available",
  running: "Working",
  archiving: "Stopping",
  archived: "Stopped",
  error: "Error",
};

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "fleet",
    title: "Boat Fleet",
    icon: "Ship",
    path: "fleet",
    component: FleetDashboard,
  });
  app.slots.settingsSection({
    id: "boat-settings",
    title: "Boat connection",
    description: "Boat API key and fleet defaults.",
    component: SettingsNote,
  });
});

function SettingsNote() {
  return (
    <div style={{ padding: 12, fontSize: 13, opacity: 0.8 }}>
      Configure the Boat API key and defaults in the plugin settings. The dashboard
      reads them server-side; secrets are never sent to the frontend.
    </div>
  );
}

function FleetDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    boxes: Box[];
    operations: Operation[];
    fetchedAt: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await rpc.call("fleetList", null);
      setData(r);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    }
  }, [rpc]);

  useRealtime("fleet-changed", () => void load());
  useRealtime("connected", () => void load());
  if (data === null && !error) {
    void load();
  }

  async function act(id: string, action: "boxStop" | "boxResume") {
    setBusy(id + action);
    try {
      await rpc.call(action, { id });
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function del(id: string) {
    if (!window.confirm(`Permanently delete ${id}? This cannot be undone.`)) return;
    setBusy(id + "delete");
    try {
      await rpc.call("boxDelete", { id, confirmId: id });
      await load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "inherit" }}>
      <h2 style={{ marginTop: 0 }}>Boat Fleet</h2>
      {error && (
        <div style={{ color: "#c0392b", padding: 8, background: "#fdecea", borderRadius: 6 }}>
          {error}
        </div>
      )}
      <CreateBox onCreated={() => void load()} />
      {data === null ? (
        <p>Loading fleet…</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ccc" }}>
              <th style={{ padding: 6 }}>Box</th>
              <th style={{ padding: 6 }}>State</th>
              <th style={{ padding: 6 }}>IP</th>
              <th style={{ padding: 6 }}>Setup</th>
              <th style={{ padding: 6 }}>Auto-archive</th>
              <th style={{ padding: 6 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.boxes.map((b) => (
              <tr key={b.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 6 }}>
                  {b.name}
                  <div style={{ opacity: 0.5, fontSize: 11 }}>{b.id}</div>
                </td>
                <td style={{ padding: 6 }}>{stateLabel[b.state] ?? b.state}</td>
                <td style={{ padding: 6 }}>{b.ip ?? "—"}</td>
                <td style={{ padding: 6 }}>{b.setupStatus ?? "—"}</td>
                <td style={{ padding: 6 }}>{b.archiveAfter ?? "no auto-stop"}</td>
                <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                  {["archived", "error"].includes(b.state) && (
                    <button onClick={() => void act(b.id, "boxResume")} style={btn}>
                      Start
                    </button>
                  )}
                  {["ready", "idle", "running"].includes(b.state) && (
                    <button onClick={() => void act(b.id, "boxStop")} style={btn}>
                      Stop
                    </button>
                  )}
                  <button
                    onClick={() => void del(b.id)}
                    disabled={busy === b.id + "delete"}
                    style={{ ...btn, color: "#c0392b" }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && (data.operations ?? []).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>Operations</h3>
          (data.operations ?? []).map((o) => (
            <div key={o.operationId} style={{ fontSize: 13, padding: 4 }}>
              {o.name} — {o.stage}
              {o.error ? ` — ${o.error}` : ""}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "3px 8px",
  marginRight: 4,
  fontSize: 12,
  cursor: "pointer",
};

function CreateBox({ onCreated }: { onCreated: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [rows, setRows] = useState([{ name: "", url: "" }]);
  const [ttl, setTtl] = useState("14400");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Array<{ name: string; databaseId: string }> | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const repos = rows.filter((r) => r.name && r.url);
      await rpc.call("boxCreate", {
        name,
        repos,
        ttlSeconds: ttl === "null" ? null : Number(ttl),
      });
      setOpen(false);
      setRows([{ name: "", url: "" }]);
      onCreated();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={{ padding: "6px 12px", cursor: "pointer" }}>
        + New project box
      </button>
    );
  }

  return (
    <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, maxWidth: 560, marginTop: 8 }}>
      <h3 style={{ marginTop: 0 }}>New project box</h3>
      <div style={{ marginBottom: 8 }}>
        <label>Box name: </label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="proj-tokenwatch" style={inp} />
      </div>
      <div style={{ marginBottom: 8 }}>
        <label>Repos (name + clone URL): </label>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input
              placeholder="name"
              value={r.name}
              onChange={(e) => setRows(rows.map((x, j) => (i === j ? { ...x, name: e.target.value } : x)))}
              style={{ ...inp, width: 140 }}
            />
            <input
              placeholder="https://github.com/…"
              value={r.url}
              onChange={(e) => setRows(rows.map((x, j) => (i === j ? { ...x, url: e.target.value } : x)))}
              style={{ ...inp, flex: 1 }}
            />
            <button onClick={() => setRows(rows.filter((_, j) => i !== j))} style={btn}>
              ✕
            </button>
          </div>
        ))}
        <button onClick={() => setRows([...rows, { name: "", url: "" }])} style={{ marginTop: 4 }}>
          + repo
        </button>
      </div>
      <div style={{ marginBottom: 8 }}>
        <label>TTL: </label>
        <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
          <option value="14400">4 hours</option>\n          <option value="null">No auto-stop</option>\n          <option value="86400">24 hours</option>
          <option value="86400">24 hours</option>
          <option value="604800">7 days</option>
        </select>
      </div>
      {error && <div style={{ color: "#c0392b", fontSize: 12 }}>{error}</div>}
      <button onClick={() => void create()} disabled={busy} style={{ padding: "6px 14px", cursor: "pointer" }}>
        {busy ? "Creating…" : "Create fork"}
      </button>{" "}
      <button onClick={() => setOpen(false)} style={{ cursor: "pointer" }}>
        Cancel
      </button>
    </div>
  );
}

const inp: React.CSSProperties = { padding: "4px 6px", marginRight: 4 };
