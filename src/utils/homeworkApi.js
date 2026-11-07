export function getApiBase() {
  try {
    const q = new URLSearchParams(window.location.search).get("backendUrl");
    if (q) return String(q).replace(/\/+$/, "");
    const ls = localStorage.getItem("satbank_backend_url");
    if (ls) return String(ls).replace(/\/+$/, "");
    if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
      return "";
    }
    if (window.SATBANK_BACKEND && window.SATBANK_BACKEND.url) {
      return String(window.SATBANK_BACKEND.url).replace(/\/+$/, "");
    }
  } catch (e) {}
  return "";
}

export function getStudentIdentity() {
  try {
    const name = String(
      (window.Net && window.Net.name) || localStorage.getItem("satbank:name") || ""
    ).trim();
    const pinInput = document.getElementById("pininput");
    const pin = String(
      (pinInput && pinInput.value) || (name ? localStorage.getItem("satbank:pin:" + name) : "") || ""
    ).trim();
    return { name, pin };
  } catch (e) {
    return { name: "", pin: "" };
  }
}

export async function hwFetch(path, opts = {}) {
  const base = getApiBase();
  const headers = {
    "Content-Type": "application/json",
    ...(opts.headers || {}),
  };
  try {
    const res = await fetch(base + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return await res.json().catch(() => ({ ok: false, error: "bad-json" }));
  } catch (e) {
    return { ok: false, error: "offline" };
  }
}

