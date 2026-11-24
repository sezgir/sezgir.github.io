// Shared by the extra games (poyga/, pistirma/): anonymous play counts for the Sezgir stats page.
// Uses the same anonymous player id as Sezgir (localStorage "sezgir:client"); sends nothing else.
(() => {
  const API = "https://sezgir-api.sezgir-uz.workers.dev";
  function client() {
    try {
      let id = JSON.parse(localStorage.getItem("sezgir:client") || '""');
      if (!/^[a-z0-9]{16,40}$/.test(id)) { id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24); localStorage.setItem("sezgir:client", JSON.stringify(id)); }
      return id;
    } catch (e) { return null; }
  }
  window.gameStat = (game, ev, extra) => {
    if (/[?&]auto/.test(location.search)) return; // test autopilot
    const c = client(); if (!c) return;
    try { fetch(API + "/game", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ game, client: c, ev, ...(extra || {}) }), keepalive: true }).catch(() => {}); } catch (e) {}
  };
})();
