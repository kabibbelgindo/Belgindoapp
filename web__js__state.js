import { api } from "./api.js";

export const state = {
  session: null,
  meta: null,
  page: null,
  reload: null,
};

export function setSessionPayload(payload) {
  state.session = payload || null;
}

export function setMeta(meta) {
  state.meta = meta || null;
  window.dispatchEvent(new CustomEvent("br:meta", { detail: meta }));
}

export async function refreshMeta() {
  const meta = await api.get("/api/meta");
  setMeta(meta);
  return meta;
}

export function currentUser() {
  return state.meta?.user || state.session?.user || null;
}

export function permissions() {
  return state.meta?.permissions || state.session?.permissions || {};
}

export function can(permission) {
  return Boolean(permissions()[permission]);
}

export function isAdmin() {
  return Boolean(permissions().is_admin);
}

export function isPrimary() {
  return Boolean(permissions().is_primary);
}

export function appInfo() {
  return state.meta?.app || state.session?.app || {};
}

export function lockedThrough() {
  return state.meta?.lock?.locked_through || null;
}

export function isLocked(dateISO) {
  const locked = lockedThrough();
  if (!locked || !dateISO) return false;
  return String(dateISO).slice(0, 10) <= locked;
}

export function hasUnclosedOpname() {
  return Boolean(state.meta?.period?.unclosed);
}

export function setPage(config = {}) {
  state.page = {
    title: config.title || "PT. BELGINDO RAYA INVENTORY",
    subtitle: config.subtitle || "",
    eyebrow: config.eyebrow || "",
    actions: Array.isArray(config.actions) ? config.actions : [],
  };
  state.reload = typeof config.reload === "function" ? config.reload : null;
  window.dispatchEvent(new CustomEvent("br:pagechange", { detail: state.page }));
}

export function setReload(fn) {
  state.reload = typeof fn === "function" ? fn : null;
}

export function navigate(path) {
  const target = String(path || "/dashboard");
  const hash = target.startsWith("#") ? target : `#${target.startsWith("/") ? "" : "/"}${target}`;
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = hash;
  }
}

export function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/dashboard";
  const [pathPart, queryPart] = raw.split("?");
  const segments = pathPart.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  return {
    raw,
    segment: segments,
    path: `/${segments.join("/")}`,
    query: new URLSearchParams(queryPart || ""),
  };
}

export function goBack(fallback = "/dashboard") {
  if (history.length > 1) history.back();
  else navigate(fallback);
}
