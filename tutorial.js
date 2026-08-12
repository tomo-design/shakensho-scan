"use strict";
/*! メカノAI 体験チュートリアル(ガイドツアー) © 2026 Cablueie.
    デモモード(?demo=1 / ss_demo)時に、実際の画面をハイライトしながら操作手順を案内する。
    既存アプリのDOMを触るだけの独立モジュール(app.jsには依存しない)。 */
(function () {
  var isDemo = function () {
    try { return new URLSearchParams(location.search).get("demo") === "1" || sessionStorage.getItem("ss_demo") === "1"; }
    catch (e) { return false; }
  };
  if (!isDemo()) return;

  var $ = function (s) { return document.querySelector(s); };
  // 表示されている(画面に出ている)要素を返す。同一セレクタが複数あってもvisibleな方を選ぶ。
  function visible(sel) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) return els[i]; }
    return null;
  }

  // ツアーの手順。sel が無ければ中央モーダル。click:true は対象タップで次へ進む。
  var STEPS = [
    { center: true, step: "体験モード", title: "メカノAIを触ってみましょう", body: "実際の画面で操作感を体験できます（サンプルの軽トラを読み込み済み・AIはサンプル応答）。案内に沿って進めてください。", cta: "はじめる" },
    { sel: "#result", step: "STEP 1 / 5", title: "車検証を読むと車両情報が出ます", body: "本番では車検証のQR・写真を撮るだけ。今回はサンプル車両（ダイハツ ハイゼットカーゴ）を読み込んでいます。" },
    { sel: "#btnGoMaint", step: "STEP 2 / 5", title: "メンテナンス諸元を見る", body: "オイル量・締付トルクなどをすぐ確認できます。ここをタップしてみましょう。", click: true },
    { sel: "#specList", also: "#btnSpecAI", step: "STEP 3 / 5", title: "諸元が即表示", body: "調べ物の時間を短縮。分からないことは「メカ君に聞く」でAIにも質問できます。若手や外国人スタッフでもすぐ戦力に。" },
    { sel: "diag-nav", step: "STEP 4 / 5", title: "故障診断もできます", body: "症状やダイアグコードから、考えられる原因と対処をAIが提案します。タップして開いてみましょう。", click: true },
    { sel: "karte-nav", step: "STEP 5 / 5", title: "整備カルテで記録・共有", body: "作業内容や写真を記録して社内で共有。担当者ごとに管理できます。タップしてみましょう。", click: true },
    { center: true, step: "体験おわり", title: "おつかれさまでした！", body: "本番では自社の車両データで、これらがすべて使えます。導入のご相談・無料デモはお気軽にどうぞ。", cta: "閉じる", showApply: true },
  ];

  var i = 0, ov, spot, tip;
  function build() {
    ov = document.createElement("div"); ov.id = "tourOv";
    spot = document.createElement("div"); spot.id = "tourSpot"; spot.style.display = "none";
    tip = document.createElement("div"); tip.id = "tourTip";
    ov.appendChild(spot); ov.appendChild(tip); document.body.appendChild(ov);
  }
  function targetFor(s) {
    if (!s.sel) return null;
    if (s.sel === "diag-nav") return visible('.navBtn[data-go="diag"]') || $("#btnGoDiag");
    if (s.sel === "karte-nav") return visible('.navBtn[data-go="karte"]') || $("#btnGoKarte");
    return visible(s.sel) || $(s.sel);
  }
  function place(el) {
    var r = el.getBoundingClientRect();
    var pad = 6;
    spot.style.display = "block";
    spot.classList.toggle("pulse", !!STEPS[i].click);
    spot.style.left = (r.left - pad) + "px";
    spot.style.top = (r.top - pad) + "px";
    spot.style.width = (r.width + pad * 2) + "px";
    spot.style.height = (r.height + pad * 2) + "px";
    // ツールチップは対象の下、はみ出すなら上
    tip.className = "";
    var below = r.bottom + 12;
    var tipH = tip.offsetHeight || 150;
    if (below + tipH > window.innerHeight - 8) {
      tip.style.top = Math.max(8, r.top - tipH - 12) + "px";
    } else {
      tip.style.top = below + "px";
    }
    var tipW = tip.offsetWidth || 300;
    var left = Math.min(Math.max(12, r.left + r.width / 2 - tipW / 2), window.innerWidth - tipW - 12);
    tip.style.left = left + "px";
  }
  function render() {
    var s = STEPS[i];
    var btns = '<div class="tt-btns">' +
      (i > 0 ? '<button class="tt-skip" data-act="skip">スキップ</button>' : '<button class="tt-skip" data-act="skip">閉じる</button>') +
      '<span class="tt-spacer"></span>' +
      (s.showApply ? '<a class="tt-next" style="text-decoration:none" href="biz.html">詳細・申込</a>' :
        '<button class="tt-next" data-act="next">' + (s.cta || "次へ") + "</button>") +
      "</div>";
    var hint = s.click ? '<div class="tt-hint">👆 光っている場所をタップ</div>' : "";
    tip.innerHTML = '<span class="tt-arrow"></span><div class="tt-step">' + s.step + "</div><h4>" + s.title + "</h4><p>" + s.body + "</p>" + hint + btns;
    tip.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () { b.dataset.act === "skip" ? end() : next(); };
    });

    if (s.center || !targetFor(s)) {
      spot.style.display = "none";
      tip.className = "center";
      tip.style.left = ""; tip.style.top = "";
      ov.classList.add("on");
      return;
    }
    var el = targetFor(s);
    // 画面内へスクロールしてから配置
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    ov.classList.add("on");
    setTimeout(function () { place(el); bindClick(el, s); }, 320);
  }
  var clickBound = null;
  function bindClick(el, s) {
    if (clickBound) { clickBound.el.removeEventListener("click", clickBound.fn); clickBound = null; }
    if (!s.click) return;
    var fn = function () { setTimeout(next, 300); };   // アプリの画面遷移を待ってから次へ
    el.addEventListener("click", fn, { once: true });
    clickBound = { el: el, fn: fn };
  }
  function next() { i++; if (i >= STEPS.length) return end(); render(); }
  function end() {
    if (clickBound) { try { clickBound.el.removeEventListener("click", clickBound.fn); } catch (e) {} clickBound = null; }
    if (ov) ov.remove();
    ov = spot = tip = null;
    ensureReplay();
  }
  function start() { i = 0; if (!ov) build(); render(); }

  // デモ中に「体験ガイド」再生ボタンを常設
  function ensureReplay() {
    if (document.getElementById("tourReplay")) return;
    var b = document.createElement("button");
    b.id = "tourReplay"; b.type = "button"; b.textContent = "❓ 体験ガイド";
    b.onclick = function () { i = 0; if (!ov) build(); render(); };
    document.body.appendChild(b);
  }

  // 対象が揃うまで待って自動開始(初回のみ)。resize時は再配置。
  function waitAndStart() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if ($("#result") && $("#result").offsetParent !== null) {
        clearInterval(t);
        var seen = false;
        try { seen = sessionStorage.getItem("ss_tourDone") === "1"; } catch (e) {}
        ensureReplay();
        if (!seen) { try { sessionStorage.setItem("ss_tourDone", "1"); } catch (e) {} start(); }
      } else if (tries > 40) { clearInterval(t); ensureReplay(); }
    }, 250);
  }
  window.addEventListener("resize", function () {
    if (ov && tip && !tip.classList.contains("center")) { var el = targetFor(STEPS[i]); if (el) place(el); }
  });

  if (document.readyState === "complete") waitAndStart();
  else window.addEventListener("load", waitAndStart);
})();
