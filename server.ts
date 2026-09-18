import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const API = "https://boat.dev/api/v1";
const DEFAULT_SNAPSHOT = "bb-boat-base-pilot-v1";
const DEFAULT_ORG = "team_df1a20c5-a1b7-4119-99b6-32cfce49847b";

const RepoRow = z.object({ name: z.string().min(1), url: z.string().url() });

export const rpcContract = defineRpcContract({
  fleetList: {
    input: z.null(),
    output: z.object({
      boxes: z.array(z.object({
        id: z.string(),
        name: z.string(),
        state: z.string(),
        ip: z.string().nullable(),
        archiveAfter: z.string().nullable(),
        setupStatus: z.string().nullable(),
      })),
      operations: z.array(z.object({
        operationId: z.string(),
        name: z.string(),
        stage: z.string(),
        sandboxId: z.string().nullable(),
        error: z.string().nullable(),
      })),
      fetchedAt: z.string(),
    }),
  },
  boxCreate: {
    input: z.object({
      name: z.string().min(1),
      repos: z.array(RepoRow),
      ttlSeconds: z.number().int().nullable().optional(),
    }),
    output: z.object({
      operationId: z.string(),
      sandboxId: z.string().nullable(),
      stage: z.string(),
    }),
  },
  boxStop: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  boxResume: {
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  },
  boxDelete: {
    input: z.object({ id: z.string(), confirmId: z.string() }),
    output: z.object({ ok: z.boolean(), operationId: z.string().nullable() }),
  },
  boxExtendTtl: {
    input: z.object({ id: z.string(), ttlSeconds: z.number().int().nullable() }),
    output: z.object({ ok: z.boolean() }),
  },
  reposGet: {
    input: z.object({ id: z.string() }),
    output: z.object({ manifest: z.string(), repos: z.array(RepoRow) }),
  },
  reposSet: {
    input: z.object({ id: z.string(), repos: z.array(RepoRow) }),
    output: z.object({ ok: z.boolean() }),
  },
  reposSyncNow: {
    input: z.object({ id: z.string() }),
    output: z.object({ started: z.boolean(), processId: z.number().nullable() }),
  },
  hostUrl: {
    input: z.object({ id: z.string() }),
    output: z.object({ url: z.string().nullable() }),
  },
  catalogRepos: {
    input: z.null(),
    output: z.object({ repos: z.array(z.object({ name: z.string(), fullName: z.string(), databaseId: z.string(), private: z.boolean().nullable() })) }),
  },
  snapshotStatus: {
    input: z.null(),
    output: z.object({ name: z.string().nullable(), status: z.string().nullable() }),
  },
});

function buildSetupScript(repos: { name: string; url: string }[]): string {
  const manifest = repos.map((r) => `${r.name} ${r.url}`).join("\n");
  return [
    "#!/usr/bin/env bash",
    "mkdir -p /home/user/workspace/repos",
    "cat > /home/user/.project-repos.txt <<'MANIFEST'",
    manifest,
    "MANIFEST",
    "chown user:user /home/user/.project-repos.txt /home/user/.project-repos.txt 2>/dev/null || true",
    "/usr/local/bin/project-repos-sync.sh",
  ].join("\n");
}

function buildManifestText(repos: { name: string; url: string }[]): string {
  return repos.map((r) => `${r.name} ${r.url}`).join("\n") + "\n";
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    boatApiKey: { type: "string", label: "Boat API key", secret: true, default: "" },
    snapshotName: { type: "string", label: "Base snapshot", default: DEFAULT_SNAPSHOT },
    orgId: { type: "string", label: "Billing org", default: DEFAULT_ORG },
  });

  const log = (...parts: unknown[]) => bb.log.info(parts.map(String).join(" "));

  async function apiKey(): Promise<string> {
    const s = await settings.get();
    const key = s.boatApiKey || process.env.BOAT_API_KEY || "";
    if (!key) throw new Error("Boat API key not configured (settings or BOAT_API_KEY env)");
    return key;
  }

  async function boat(path: string, init: RequestInit = {}): Promise<any> {
    const key = await apiKey();
    const org = (await settings.get()).orgId;
    const r = await fetch(API + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Boat-Org": org,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const body = await r.json().catch(() => ({}));
    if (!body.ok) {
      const err = new Error(body?.error?.message || body?.message || `Boat API ${r.status}`);
      (err as any).boatCode = body?.error?.code;
      (err as any).boatStatus = r.status;
      throw err;
    }
    return body;
  }

  function redact(u: string | null | undefined): string | null {
    if (!u) return null;
    return u.split("?")[0];
  }

  bb.rpc.register(rpcContract, {
    async fleetList() {
      const list = await boat("/sandboxes?limit=200");
      const ops = (await bb.storage.kv.list("op:")) as Array<{ key: string; value: any }>;
      return {
        boxes: (list.sandboxes ?? []).map((s: any) => ({
          id: s.id,
          name: s.name,
          state: s.state,
          ip: s.ip ?? null,
          archiveAfter: s.archiveAfter ?? null,
          setupStatus: s.setupStatus ?? null,
        })),
        operations: (ops ?? []).flatMap((row: any) => {
          let v: any;
          try {
            v = typeof row?.value === "string" ? JSON.parse(row.value) : row?.value;
          } catch {
            return [];
          }
          if (!v || typeof v !== "object" || !v.operationId) return [];
          return [{
            operationId: String(v.operationId),
            name: String(v.name ?? "?"),
            stage: String(v.stage ?? "?"),
            sandboxId: v.sandboxId ?? null,
            error: v.error ?? null,
          }];
        }),
        fetchedAt: new Date().toISOString(),
      };
    },

    async boxCreate(input) {
      // Deterministic idempotency: the operation id and Boat Idempotency-Key are
      // derived from the full request identity (name + exact create body), so a
      // retry or concurrent duplicate of the same logical create reuses the same
      // record, and Boat replays/dedupes server-side. Different parameters hash
      // to a different key and can never hijack another request's box.
      const snap = await settings.get();
      const body = {
        from: snap.snapshotName,
        org: snap.orgId,
        ttlSeconds: input.ttlSeconds ?? null,
        setupScript: buildSetupScript(input.repos),
      };
      const identity = JSON.stringify({ name: input.name, body });
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
      const opId = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 32);

      const priorRec = (await bb.storage.kv.get(`op:${opId}`)) as any;
      if (priorRec && priorRec.sandboxId && ["creating", "provisioning"].includes(priorRec.stage)) {
        try {
          const s = await boat(`/sandboxes/${priorRec.sandboxId}`);
          if (s?.sandbox?.id) {
            return { operationId: opId, sandboxId: priorRec.sandboxId, stage: priorRec.stage };
          }
        } catch {
          // box deleted; fall through and create fresh
        }
      }

      const rec = {
        operationId: opId,
        idemKey: opId,
        name: input.name,
        repos: input.repos,
        stage: "creating",
        sandboxId: null as string | null,
        error: null as string | null,
        startedAt: new Date().toISOString(),
      };
      await bb.storage.kv.set(`op:${opId}`, rec);
      try {
        const r = await boat("/sandboxes", {
          method: "POST",
          headers: { "Idempotency-Key": idemKey },
          body: JSON.stringify(body),
        });
        rec.sandboxId = r.sandbox?.id ?? null;
        rec.stage = "provisioning";
        await bb.storage.kv.set(`op:${opId}`, rec);
        if (rec.sandboxId) {
          try {
            await boat(`/sandboxes/${rec.sandboxId}`, {
              method: "PATCH",
              body: JSON.stringify({ name: input.name }),
            });
          } catch (e) {
            log("rename deferred:", String(e));
          }
        }
        bb.realtime.publish("fleet-changed", { op: opId });
        return { operationId: opId, sandboxId: rec.sandboxId, stage: rec.stage };
      } catch (e: any) {
        rec.stage = "failed";
        rec.error = String(e?.message ?? e);
        await bb.storage.kv.set(`op:${opId}`, rec);
        // A concurrent duplicate of the same logical create surfaces as Boat's
        // idempotency_in_progress; retrying later replays the original result.
        throw e;
      }
    },

    async boxStop({ id }) {
      await boat(`/sandboxes/${id}/stop`, { method: "POST", body: "{}" });
      bb.realtime.publish("fleet-changed", { id });
      return { ok: true };
    },

    async boxResume({ id }) {
      await boat(`/sandboxes/${id}/resume`, { method: "POST", body: "{}" });
      bb.realtime.publish("fleet-changed", { id });
      return { ok: true };
    },

    async boxDelete({ id, confirmId }) {
      if (confirmId !== id) throw new Error("confirm id mismatch");
      const r = await boat(`/sandboxes/${id}`, {
        method: "DELETE",
        headers: { "X-Ascii-Confirm-Delete": id },
      });
      const opId = r.operation?.id ?? null;
      bb.realtime.publish("fleet-changed", { id });
      return { ok: true, operationId: opId };
    },

    async boxExtendTtl({ id, ttlSeconds }) {
      await boat(`/sandboxes/${id}`, { method: "PATCH", body: JSON.stringify({ ttlSeconds }) });
      bb.realtime.publish("fleet-changed", { id });
      return { ok: true };
    },

    async reposGet({ id }) {
      const r = await boat(`/sandboxes/${id}/files?path=%2Fhome%2Fuser%2F.project-repos.txt`);
      const manifest = r.content ?? "";
      const repos = manifest.trim() ? manifest.trim().split("\n").map((line: string) => {
        const [name, url] = line.split(/\s+/);
        return { name, url };
      }) : [];
      return { manifest, repos };
    },

    async reposSet({ id, repos }) {
      const manifest = buildManifestText(repos);
      await boat(`/sandboxes/${id}/files`, {
        method: "PUT",
        body: JSON.stringify({ path: "/home/user/.project-repos.txt", content: manifest }),
      });
      bb.realtime.publish("fleet-changed", { id });
      return { ok: true };
    },

    async reposSyncNow({ id }) {
      const r = await boat(`/sandboxes/${id}/commands`, {
        method: "POST",
        body: JSON.stringify({
          command: "/usr/local/bin/project-repos-sync.sh",
          detached: true,
        }),
      });
      return { started: true, processId: r.processId ?? null };
    },

    async hostUrl({ id }) {
      const r = await boat(`/sandboxes/${id}/host`, {
        method: "POST",
        body: JSON.stringify({ port: 38886, title: "BB" }),
      });
      return { url: redact(r.url) ?? null };
    },

    async catalogRepos() {
      const r = await boat("/repos?limit=200");
      const out: Array<{ name: string; fullName: string; databaseId: string; private: boolean | null }> = [];
      for (const inst of r.installations ?? []) {
        for (const repo of inst.repositories ?? []) {
          out.push({ name: repo.name, fullName: repo.fullName ?? repo.name, databaseId: String(repo.databaseId), private: repo.private ?? null });
        }
      }
      return { repos: out };
    },

    async snapshotStatus() {
      const snap = await settings.get();
      const r = await boat(`/named-snapshots/${snap.snapshotName}`);
      return { name: r.snapshot?.name ?? null, status: r.snapshot?.status ?? null };
    },
  });

  bb.background.service("fleet-poller", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const list = await boat("/sandboxes?limit=200");
          bb.realtime.publish("fleet-changed", { at: new Date().toISOString() });
        } catch (e) {
          log("poll error:", String(e));
        }
        // Sleep resolves immediately on abort so stop() is prompt.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 45_000);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
    },
  });

  function redact(u: string | null | undefined): string | null {
    if (!u) return null;
    return u.split("?")[0];
  }
}
