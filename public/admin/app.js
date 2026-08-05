"use strict";
/**
 * Heirs OCR admin console — a single-file vanilla-JS client for the /admin JSON API.
 * No framework, no external requests. The httpOnly session cookie is sent
 * automatically (same-origin), so there is no token to store here.
 */

const ROLE_RANK = { viewer: 0, manager: 1, owner: 2 };
let me = null; // { user, role }

// ── API helper ────────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const res = await fetch("/admin/api" + path, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const show = (el, on) => el.classList.toggle("hidden", !on);
const canManage = () => ROLE_RANK[me.role] >= ROLE_RANK.manager;

// ── Session / bootstrap ───────────────────────────────────────────────────────
async function boot() {
  try {
    me = await api("GET", "/me");
    enterApp();
  } catch (_) {
    show($("#app"), false);
    show($("#login"), true);
  }
}

function enterApp() {
  show($("#login"), false);
  show($("#app"), true);
  $("#who-name").textContent = `${me.user.email} · ${me.role}`;

  // Role-gate tabs and action buttons declaratively via data-role.
  document.querySelectorAll("[data-role]").forEach((el) => {
    show(el, ROLE_RANK[me.role] >= ROLE_RANK[el.dataset.role]);
  });

  // A viewer can't see Tenants/Admins; land them on Observability.
  switchTab("observability");
}

// ── Login ─────────────────────────────────────────────────────────────────────
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  const btn = $("#login-form button[type=submit]");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    me = await api("POST", "/login", {
      email: $("#login-email").value,
      password: $("#login-password").value,
    });
    enterApp();
  } catch (err) {
    $("#login-error").textContent = err.message || "Sign in failed";
  } finally {
    // Re-enable so a failed attempt can be retried. (On success the login view is
    // hidden by enterApp, so this just restores it for next time.)
    btn.disabled = false;
    btn.textContent = label;
  }
});

$("#logout").addEventListener("click", async () => {
  try {
    await api("POST", "/logout");
  } catch (_) {
    /* ignore */
  }
  me = null;
  location.reload();
});

// ── Tabs ──────────────────────────────────────────────────────────────────────
$("#tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (btn) switchTab(btn.dataset.tab);
});

function switchTab(name) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => show(v, v.dataset.view === name));
  if (name === "observability") loadObservability();
  if (name === "tenants") loadTenants();
  if (name === "admins") loadAdmins();
}

$("#refresh").addEventListener("click", loadObservability);

// ── Observability ─────────────────────────────────────────────────────────────
async function loadObservability() {
  try {
    const [summary, health, queue, usage] = await Promise.all([
      api("GET", "/metrics/summary"),
      api("GET", "/health"),
      api("GET", "/queue"),
      api("GET", "/usage"),
    ]);
    renderTiles(summary, queue);
    renderHealth(health);
    renderQueue(queue);
    renderUsage(usage.usage);
    renderByFunction(summary.byFunction);
  } catch (err) {
    if (err.status === 401) return boot();
  }
}

function renderTiles(s, q) {
  const pct = (n) => (n * 100).toFixed(1) + "%";
  const tiles = [
    { lbl: "Requests", val: s.totalRequests },
    { lbl: "Error rate", val: pct(s.errorRate) },
    { lbl: "Tokens used", val: s.totalTokens.toLocaleString() },
    { lbl: "Provider fallbacks", val: s.providerFallbacks },
    { lbl: "Queue depth", val: q.counts.waiting + q.counts.active },
  ];
  $("#stat-tiles").innerHTML = tiles
    .map((t) => `<div class="tile"><div class="val">${esc(t.val)}</div><div class="lbl">${esc(t.lbl)}</div></div>`)
    .join("");
}

function renderHealth(h) {
  const dot = (on) => `<span class="dot ${on ? "on" : "off"}"></span>`;
  const rows = [
    ["Redis", h.redis],
    ["Tesseract", h.providers.tesseract],
    ["GLM-OCR", h.providers.glm],
    ["Azure OpenAI", h.providers.azureOpenAI],
  ];
  $("#health").innerHTML =
    `<table><tbody>` +
    rows.map(([k, on]) => `<tr><td>${dot(on)}${esc(k)}</td><td>${on ? "enabled" : "off"}</td></tr>`).join("") +
    `</tbody></table><p class="muted" style="margin:.6rem 0 0">version ${esc(h.version)}</p>`;
}

function renderQueue(q) {
  const c = q.counts;
  let html =
    `<table><tbody>` +
    `<tr><td>Waiting</td><td>${c.waiting}</td><td>Active</td><td>${c.active}</td></tr>` +
    `<tr><td>Completed</td><td>${c.completed}</td><td>Failed</td><td>${c.failed}</td></tr>` +
    `</tbody></table>`;
  if (q.recent.length) {
    html +=
      `<table style="margin-top:.75rem"><thead><tr><th>Job</th><th>Fn</th><th>Status</th></tr></thead><tbody>` +
      q.recent
        .map(
          (j) =>
            `<tr><td class="mono">${esc(j.jobId)}</td><td>${esc(j.function)}</td>` +
            `<td><span class="badge ${j.status === "failed" ? "err" : "warn"}">${esc(j.status)}</span></td></tr>`,
        )
        .join("") +
      `</tbody></table>`;
  }
  $("#queue").innerHTML = html;
}

function renderUsage(rows) {
  if (!rows.length) return ($("#usage").innerHTML = `<p class="empty">No usage recorded yet.</p>`);
  $("#usage").innerHTML =
    `<table><thead><tr><th>Tenant</th><th>Requests</th><th>Errors</th><th>Tokens</th></tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td>${esc(r.tenantId)}</td><td>${r.requests}</td><td>${r.errors}</td><td>${r.tokens.toLocaleString()}</td></tr>`,
      )
      .join("") +
    `</tbody></table>`;
}

function renderByFunction(rows) {
  if (!rows.length) return ($("#by-function").innerHTML = `<p class="empty">No traffic yet.</p>`);
  $("#by-function").innerHTML =
    `<table><thead><tr><th>Function</th><th>Requests</th><th>Errors</th><th>Tokens</th><th>Low-conf</th></tr></thead><tbody>` +
    rows
      .map(
        (r) =>
          `<tr><td>${esc(r.function)}</td><td>${r.requests}</td><td>${r.errors}</td>` +
          `<td>${r.tokens.toLocaleString()}</td><td>${(r.lowConfidenceRatio * 100).toFixed(1)}%</td></tr>`,
      )
      .join("") +
    `</tbody></table>`;
}

// ── Tenants ───────────────────────────────────────────────────────────────────
async function loadTenants() {
  try {
    const { tenants } = await api("GET", "/tenants");
    renderTenants(tenants);
  } catch (err) {
    if (err.status === 401) return boot();
  }
}

function renderTenants(rows) {
  if (!rows.length) return ($("#tenants").innerHTML = `<p class="empty">No tenants yet.</p>`);
  const editable = canManage();
  $("#tenants").innerHTML =
    `<table><thead><tr><th>Tenant</th><th>Functions</th><th>Rate</th><th>Status</th><th>Created</th>` +
    (editable ? `<th></th>` : ``) +
    `</tr></thead><tbody>` +
    rows
      .map(({ keyHash, tenant: t }) => {
        const fns = t.allowedFunctions && t.allowedFunctions.length ? t.allowedFunctions.join(", ") : "ALL";
        const status = t.disabled
          ? `<span class="badge off">disabled</span>`
          : `<span class="badge ok">active</span>`;
        const created = t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "—";
        const actions = editable
          ? `<td class="actions">
               <button data-act="toggle" data-hash="${esc(keyHash)}" data-disabled="${!!t.disabled}">${t.disabled ? "Enable" : "Disable"}</button>
               <button class="danger" data-act="revoke" data-hash="${esc(keyHash)}" data-id="${esc(t.tenantId)}">Revoke</button>
             </td>`
          : ``;
        return `<tr><td>${esc(t.tenantId)}</td><td>${esc(fns)}</td><td>${esc(t.rateLimit ?? "default")}</td><td>${status}</td><td>${esc(created)}</td>${actions}</tr>`;
      })
      .join("") +
    `</tbody></table>`;
}

$("#tenants").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const hash = btn.dataset.hash;
  if (btn.dataset.act === "toggle") {
    await api("PATCH", `/tenants/${hash}`, { disabled: btn.dataset.disabled !== "true" });
    loadTenants();
  } else if (btn.dataset.act === "revoke") {
    if (!confirm(`Revoke tenant "${btn.dataset.id}"? Its API key stops working immediately.`)) return;
    await api("DELETE", `/tenants/${hash}`);
    loadTenants();
  }
});

$("#new-tenant").addEventListener("click", async () => {
  const { functions } = await api("GET", "/functions");
  openModal(`
    <h3>New tenant</h3>
    <label>Tenant ID<input id="t-id" placeholder="acme-corp" /></label>
    <label>Name (optional)<input id="t-name" /></label>
    <label>Rate limit / window (optional)<input id="t-rate" type="number" min="1" /></label>
    <label>Allowed functions (blank = all)
      <select id="t-fns" multiple size="4">${functions.map((f) => `<option>${esc(f)}</option>`).join("")}</select>
    </label>
    <p class="error" id="t-err"></p>
    <div class="row"><button data-close class="ghost">Cancel</button><button id="t-save" class="primary">Create</button></div>
  `);
  $("#t-save").addEventListener("click", async () => {
    const body = { tenantId: $("#t-id").value.trim() };
    if ($("#t-name").value.trim()) body.name = $("#t-name").value.trim();
    if ($("#t-rate").value) body.rateLimit = Number($("#t-rate").value);
    const fns = [...$("#t-fns").selectedOptions].map((o) => o.value);
    if (fns.length) body.allowedFunctions = fns;
    try {
      const { apiKey } = await api("POST", "/tenants", body);
      showKeyModal(body.tenantId, apiKey);
      loadTenants();
    } catch (err) {
      $("#t-err").textContent = err.message;
    }
  });
});

function showKeyModal(tenantId, apiKey) {
  openModal(`
    <h3>Tenant "${esc(tenantId)}" created</h3>
    <p class="muted">Copy this API key now — it is shown once and cannot be recovered.</p>
    <div class="keybox" id="key">${esc(apiKey)}</div>
    <div class="row"><button id="copy" class="ghost">Copy</button><button data-close class="primary">Done</button></div>
  `);
  $("#copy").addEventListener("click", () => navigator.clipboard.writeText(apiKey));
}

// ── Admins ────────────────────────────────────────────────────────────────────
async function loadAdmins() {
  try {
    const { admins } = await api("GET", "/admins");
    renderAdmins(admins);
  } catch (err) {
    if (err.status === 401) return boot();
  }
}

function renderAdmins(rows) {
  $("#admins").innerHTML =
    `<table><thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>` +
    rows
      .map((a) => {
        const status = a.disabled ? `<span class="badge off">disabled</span>` : `<span class="badge ok">active</span>`;
        return `<tr>
          <td>${esc(a.email)}</td><td>${esc(a.name)}</td>
          <td><span class="badge warn">${esc(a.role)}</span></td><td>${status}</td>
          <td class="actions">
            <button data-act="edit" data-id="${esc(a.id)}">Edit</button>
            <button class="danger" data-act="del" data-id="${esc(a.id)}" data-email="${esc(a.email)}">Delete</button>
          </td></tr>`;
      })
      .join("") +
    `</tbody></table>`;
  window.__admins = rows;
}

$("#admins").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  if (btn.dataset.act === "del") {
    if (!confirm(`Delete admin "${btn.dataset.email}"?`)) return;
    try {
      await api("DELETE", `/admins/${btn.dataset.id}`);
      loadAdmins();
    } catch (err) {
      alert(err.message);
    }
  } else if (btn.dataset.act === "edit") {
    const a = (window.__admins || []).find((x) => x.id === btn.dataset.id);
    openAdminModal(a);
  }
});

$("#new-admin").addEventListener("click", () => openAdminModal(null));

function openAdminModal(existing) {
  const roles = ["owner", "manager", "viewer"];
  openModal(`
    <h3>${existing ? "Edit admin" : "New admin"}</h3>
    <label>Email<input id="a-email" value="${esc(existing ? existing.email : "")}" ${existing ? "disabled" : ""} /></label>
    <label>Name<input id="a-name" value="${esc(existing ? existing.name : "")}" /></label>
    <label>Role<select id="a-role">${roles.map((r) => `<option ${existing && existing.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></label>
    <label>${existing ? "New password (blank = unchanged)" : "Password (min 8)"}<input id="a-pass" type="password" /></label>
    ${existing ? `<label style="flex-direction:row;align-items:center;gap:.5rem"><input type="checkbox" id="a-disabled" ${existing.disabled ? "checked" : ""} style="width:auto"/> Disabled</label>` : ""}
    <p class="error" id="a-err"></p>
    <div class="row"><button data-close class="ghost">Cancel</button><button id="a-save" class="primary">Save</button></div>
  `);
  $("#a-save").addEventListener("click", async () => {
    try {
      if (existing) {
        const body = { name: $("#a-name").value.trim(), role: $("#a-role").value, disabled: $("#a-disabled").checked };
        if ($("#a-pass").value) body.password = $("#a-pass").value;
        await api("PATCH", `/admins/${existing.id}`, body);
      } else {
        await api("POST", "/admins", {
          email: $("#a-email").value.trim(),
          name: $("#a-name").value.trim(),
          role: $("#a-role").value,
          password: $("#a-pass").value,
        });
      }
      closeModal();
      loadAdmins();
    } catch (err) {
      $("#a-err").textContent = err.message;
    }
  });
}

// ── Modal ─────────────────────────────────────────────────────────────────────
function openModal(html) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  root.querySelector(".modal-backdrop").addEventListener("click", (e) => {
    if (e.target.classList.contains("modal-backdrop") || e.target.hasAttribute("data-close")) closeModal();
  });
}
function closeModal() {
  $("#modal-root").innerHTML = "";
}

boot();
