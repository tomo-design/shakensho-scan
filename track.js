"use strict";
/*! メカノAI 入口の回数カウント © 2026 Cablueie.
    検索→整備メモ→デモ→Pocket登録 のどこで人が離れているかを知るために、出来事の「回数」だけを数える。
    ・送るのは出来事の名前と、整備メモの場合はページ名だけ。個人を特定する情報・Cookieは使わない。
    ・集計は Cloud Functions の track が funnelDaily/{日付} に足し込み、毎朝の日報に載る。
    ・自分の端末を数えたくない時は、どのページでも一度 ?notrack=1 を付けて開く(?notrack=0 で解除)。
    app.js より前に読み込むこと(app.js が ?demo= や ?pocket= をURLから消す前に見るため)。 */
(function () {
  var ENDPOINT = "https://asia-northeast1-mecanoai.cloudfunctions.net/track";
  var qs = null;
  try { qs = new URLSearchParams(location.search); } catch (e) {}
  try {
    if (qs && qs.get("notrack") === "1") localStorage.setItem("ss_notrack", "1");
    if (qs && qs.get("notrack") === "0") localStorage.removeItem("ss_notrack");
  } catch (e) {}

  function off() {
    try { if (localStorage.getItem("ss_notrack") === "1") return true; } catch (e) {}
    if (!/(^|\.)mechanoai-cablueie\.com$/.test(location.hostname)) return true;   // 手元の確認環境は数えない
    return /bot|crawl|spider|slurp|headless|lighthouse/i.test(navigator.userAgent || "");
  }
  function send(ev, page) {
    if (off()) return;
    try {
      var body = JSON.stringify({ e: ev, p: page || "" });
      // text/plain で送る(プリフライト無しで、ページ移動の直前でも届く)
      if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "text/plain" }));
      else fetch(ENDPOINT, { method: "POST", body: body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(function () {});
    } catch (e) {}
  }
  // 同じタブで同じ出来事を二重に数えない(再読み込み・ガイドのやり直し)
  function once(ev, page) {
    try { if (sessionStorage.getItem("ss_trk_" + ev) === "1") return; sessionStorage.setItem("ss_trk_" + ev, "1"); } catch (e) {}
    send(ev, page);
  }
  window.mechaTrack = function (ev) { once(ev); };

  /* ---- 整備メモ(guide/) ---- */
  var g = /\/guide\/(?:(tebiki|symptom|dtc)\/([\w-]+)\.html|index\.html)?$/.exec(location.pathname);
  if (g) {
    send("guide_view", g[1] ? g[1] + "_" + g[2] : "index");
    // 端末数の目安: 同じ端末は1日1回だけ数える
    try {
      var d = new Date(), today = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
      if (localStorage.getItem("ss_trk_gv") !== today) { localStorage.setItem("ss_trk_gv", today); send("guide_uv"); }
    } catch (e) {}
    document.addEventListener("click", function (e) {
      var a = e.target && e.target.closest ? e.target.closest(".cta a") : null;
      if (!a) return;
      var h = a.getAttribute("href") || "";
      if (h.indexOf("demo=1") >= 0) send("guide_cta_demo");
      else if (h.indexOf("pocket=start") >= 0) send("guide_cta_pocket");
      else if (h.indexOf("biz.html") >= 0) send("guide_cta_biz");
    }, true);
    return;
  }

  /* ---- アプリ本体(デモ・Pocket登録フォーム) ---- */
  if (qs && qs.get("demo") === "1") once("demo_start");
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest("#agDemo")) once("demo_start");
    else if (t.closest('#tourTip [data-act="pocket"]')) send("demo_cta_pocket");
    else if (t.closest("#tourTip a.tt-alt")) send("demo_cta_biz");
    else if (t.closest("#pocketApplySend")) send("pocket_submit");
  }, true);
  // Pocketの無料登録フォームが開いた回数(リンク・デモ・ログイン画面のどこから開いても数える)
  function watchForm() {
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        for (var j = 0; j < list[i].addedNodes.length; j++) {
          if (list[i].addedNodes[j].id === "pocketApplyOv") { send("pocket_form"); return; }
        }
      }
    }).observe(document.body, { childList: true });
  }
  if (document.body) watchForm(); else document.addEventListener("DOMContentLoaded", watchForm);
})();
