"use strict";
/*! メカノAI 体験チュートリアル(ガイドツアー) © 2026 Cablueie.
    デモモード(?demo=1 / ss_demo)時に、実際の画面をハイライトしながら操作手順を案内する。
    ・オーバーレイはクリックを奪わない(光っている実ボタンをそのままタップできる)
    ・診断/修理は例文を入力して「押す」体験まで誘導する
    既存アプリのDOMを触るだけの独立モジュール(app.jsには依存しない)。 */
(function () {
  function isDemo() {
    try { return new URLSearchParams(location.search).get("demo") === "1" || sessionStorage.getItem("ss_demo") === "1"; }
    catch (e) { return false; }
  }
  if (!isDemo()) return;

  var $ = function (s) { return document.querySelector(s); };
  // 画面に出ている(表示されている)要素を返す。同一セレクタが複数あってもvisibleな方を選ぶ。
  function visible(sel) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) return els[i]; }
    return null;
  }

  // 手順。sel:対象 / click:true=対象タップ(または「次へ」)で進み、アプリが画面遷移する
  //       fill:{value}=対象に例文を入れて誘導 / also=一緒に光らせる補助
  var STEPS = [
    { center: true, step: "体験モード", title: "メカノAIを触ってみましょう", body: "実際の画面で操作感を体験できます（サンプルの軽トラを読み込み済み・AIはサンプル応答）。案内に沿って、光っている場所をタップしてみてください。", cta: "はじめる" },
    { sel: "#result", step: "STEP 1 / 6", title: "車検証を読むと車両情報が出ます", body: "本番では車検証のQR・写真を撮るだけ。今回はサンプル車両（ダイハツ ハイゼットカーゴ）を読み込んでいます。" },
    { sel: "#btnGoMaint", click: true, step: "STEP 2 / 6", title: "メンテナンス諸元を見る", body: "オイル量・締付トルクなどをすぐ確認できます。この光っているボタンをタップしてみましょう。" },
    { sel: "#specList", also: "#btnSpecAI", step: "STEP 3 / 6", title: "諸元が即表示", body: "調べ物の時間を短縮。分からないことは「メカ君に聞く」でAIにも質問できます。若手や外国人スタッフでもすぐ戦力に。" },
    { sel: "diag-nav", click: true, step: "STEP 4 / 6", title: "故障診断を開く", body: "下のメニューの「🩺 診断」をタップしてみましょう。" },
    { sel: "#diagText", fill: { value: "P0401" }, step: "STEP 4 / 6", title: "ここに症状やコードを入力", body: "例として「P0401」を入力しました。実際はダイアグコードや「エンストする」等の症状でOK。この下の〔メカ君に聞く〕を押します。" },
    { sel: "#btnDiagRun", click: true, step: "STEP 4 / 6", title: "AIに診断させる", body: "「メカ君に聞く」を押すと、原因の切り分けや対処をAIが回答します（デモはサンプル回答）。押してみましょう。" },
    { sel: "parts-nav", click: true, step: "STEP 5 / 6", title: "修理（部品・注文）を開く", body: "続いて「🛠 修理」をタップ。必要部品の洗い出しや注文リスト作成ができます。" },
    { sel: "#qVehText", fill: { value: "ブレーキパッド交換" }, also: "#btnVehAsk", step: "STEP 5 / 6", title: "作業名を入れるだけでOK", body: "例として「ブレーキパッド交換」を入力しました。〔メカ君に聞く〕を押すと、必要部品や手順を提案します（デモはサンプル）。" },
    { sel: "karte-nav", click: true, step: "STEP 6 / 6", title: "整備カルテを開く", body: "最後に「📋 カルテ」をタップ。作業内容を記録して社内で共有できます。" },
    { sel: "#btnKarteAdd", also: "#karteList", step: "STEP 6 / 6", title: "作業記録を残して共有", body: "「＋」から作業記録を追加。写真での入力にも対応。担当者ごとに管理でき、引き継ぎもスムーズです。" },
    { center: true, step: "体験おわり", title: "おつかれさまでした！", body: "本番では自社の車両データで、これらがすべて使えます。導入のご相談・無料デモはお気軽にどうぞ。", cta: "閉じる", showApply: true },
  ];

  var i = 0, ov, spot, tip, curEl = null, stepDone = false, clickFn = null;

  function build() {
    ov = document.createElement("div"); ov.id = "tourOv";
    spot = document.createElement("div"); spot.id = "tourSpot"; spot.style.display = "none";
    tip = document.createElement("div"); tip.id = "tourTip";
    ov.appendChild(spot); ov.appendChild(tip); document.body.appendChild(ov);
  }
  function targetFor(s) {
    if (!s.sel) return null;
    if (s.sel === "diag-nav") return visible('.navBtn[data-go="diag"]') || $("#btnGoDiag");
    if (s.sel === "parts-nav") return visible('.navBtn[data-go="parts"]') || $("#btnGoParts");
    if (s.sel === "karte-nav") return visible('.navBtn[data-go="karte"]') || $("#btnGoKarte");
    return visible(s.sel) || $(s.sel);
  }
  function place(el, s) {
    var r = el.getBoundingClientRect();
    var also = s.also ? (visible(s.also) || $(s.also)) : null;
    var rect = r;
    if (also) { // 補助要素も囲む
      var r2 = also.getBoundingClientRect();
      rect = { left: Math.min(r.left, r2.left), top: Math.min(r.top, r2.top), right: Math.max(r.right, r2.right), bottom: Math.max(r.bottom, r2.bottom) };
      rect.width = rect.right - rect.left; rect.height = rect.bottom - rect.top;
    }
    var pad = 6;
    spot.style.display = "block";
    spot.classList.toggle("pulse", !!s.click);
    spot.style.left = (rect.left - pad) + "px";
    spot.style.top = (rect.top - pad) + "px";
    spot.style.width = (rect.width + pad * 2) + "px";
    spot.style.height = (rect.height + pad * 2) + "px";
    // ツールチップ: 対象の下、はみ出すなら上
    var tipH = tip.offsetHeight || 160, tipW = tip.offsetWidth || 300;
    var below = rect.bottom + 12;
    tip.style.top = (below + tipH > window.innerHeight - 8 ? Math.max(8, rect.top - tipH - 12) : below) + "px";
    tip.style.left = Math.min(Math.max(12, rect.left + rect.width / 2 - tipW / 2), window.innerWidth - tipW - 12) + "px";
  }
  function unbind() {
    if (clickFn && curEl) { try { curEl.removeEventListener("click", clickFn); } catch (e) {} }
    clickFn = null;
  }
  function advance() { if (stepDone) return; stepDone = true; unbind(); i++; if (i >= STEPS.length) return end(); render(); }

  function render() {
    var s = STEPS[i];
    stepDone = false; unbind(); curEl = null;
    var btns = '<div class="tt-btns">' +
      '<button class="tt-skip" data-act="skip">' + (i > 0 ? "スキップ" : "閉じる") + "</button>" +
      '<span class="tt-spacer"></span>' +
      (s.showApply ? '<a class="tt-next" style="text-decoration:none" href="biz.html">詳細・申込</a>' :
        '<button class="tt-next" data-act="next">' + (s.cta || "次へ") + "</button>") +
      "</div>";
    var hint = s.click ? '<div class="tt-hint">👆 光っている場所をタップ</div>' : "";
    tip.innerHTML = '<div class="tt-step">' + s.step + "</div><h4>" + s.title + "</h4><p>" + s.body + "</p>" + hint + btns;
    tip.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.act === "skip") return end();
        if (s.click && curEl) { unbind(); try { curEl.click(); } catch (e) {} setTimeout(advance, 260); }
        else advance();
      };
    });

    if (s.center) { spot.style.display = "none"; tip.className = "center"; tip.style.left = ""; tip.style.top = ""; return; }
    tip.className = "";
    waitForTarget(s, 0);
  }
  // 対象が表示されるまで少し待つ(画面遷移直後の未表示に対応)。出なければ中央表示にフォールバック。
  function waitForTarget(s, tries) {
    var el = targetFor(s);
    if (el && el.offsetParent !== null) {
      curEl = el;
      if (s.fill) { try { if (!el.value) { el.value = s.fill.value; el.dispatchEvent(new Event("input", { bubbles: true })); } el.focus({ preventScroll: true }); } catch (e) {} }
      try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      setTimeout(function () {
        if (STEPS[i] !== s) return;   // 既に進んでいたら無視
        place(el, s);
        if (s.click) { clickFn = function () { setTimeout(advance, 260); }; el.addEventListener("click", clickFn, { once: true }); }
      }, 340);
      return;
    }
    if (tries < 12) { setTimeout(function () { waitForTarget(s, tries + 1); }, 200); return; }
    // 見つからない → 中央表示で続行
    spot.style.display = "none"; tip.className = "center"; tip.style.left = ""; tip.style.top = "";
  }

  function end() {
    unbind(); if (ov) ov.remove(); ov = spot = tip = null; curEl = null;
    ensureReplay();
  }
  function start() { i = 0; if (!ov) build(); render(); }

  function ensureReplay() {
    if (document.getElementById("tourReplay")) return;
    var b = document.createElement("button");
    b.id = "tourReplay"; b.type = "button"; b.textContent = "❓ 体験ガイド";
    b.onclick = function () { i = 0; if (!ov) build(); render(); };
    document.body.appendChild(b);
  }

  function waitAndStart() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      if ($("#result") && $("#result").offsetParent !== null) {
        clearInterval(t);
        ensureReplay();
        var seen = false; try { seen = sessionStorage.getItem("ss_tourDone") === "1"; } catch (e) {}
        if (!seen) { try { sessionStorage.setItem("ss_tourDone", "1"); } catch (e) {} start(); }
      } else if (tries > 40) { clearInterval(t); ensureReplay(); }
    }, 250);
  }
  window.addEventListener("resize", function () {
    var s = STEPS[i];
    if (ov && tip && s && !s.center && curEl) place(curEl, s);
  });

  if (document.readyState === "complete") waitAndStart();
  else window.addEventListener("load", waitAndStart);
})();
