"use strict";
/*! メカノAI 体験チュートリアル(ガイドツアー) © 2026 Cablueie.
    デモモード(?demo=1 / ss_demo)時に、実際の画面をハイライトしながら操作手順を案内する。
    ・暗幕(マスク)で「光っている対象だけ」タップ可能にし、他の場所は無効化
    ・診断/修理は例文を入れ、「メカ君に聞く」を押させて結果まで体験させる
    既存アプリのDOMを触るだけの独立モジュール(app.jsには依存しない)。 */
(function () {
  function isDemo() {
    try { return new URLSearchParams(location.search).get("demo") === "1" || sessionStorage.getItem("ss_demo") === "1"; }
    catch (e) { return false; }
  }
  if (!isDemo()) return;

  var $ = function (s) { return document.querySelector(s); };
  function visible(sel) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) return els[i]; }
    return null;
  }

  // 種別: center=中央説明 / (既定)=説明のみ / nav=タップで画面遷移(自動で次へ) /
  //       action=タップでその場に結果表示(次へで進む) / fill=例文を入れて誘導
  var STEPS = [
    { center: true, step: "体験モード", title: "メカノAIを触ってみましょう", body: "実際の画面で操作感を体験できます（サンプルの軽トラを読み込み済み・AIはサンプル応答）。光っている場所をタップして進めてください。", cta: "はじめる" },
    { sel: "#result", step: "STEP 1 / 6", title: "車検証を読むと車両情報が出ます", body: "本番では車検証のQR・写真を撮るだけ。今回はサンプル車両（ダイハツ ハイゼットカーゴ）を読み込んでいます。" },
    { sel: "#btnGoMaint", nav: true, step: "STEP 2 / 6", title: "メンテナンス諸元を見る", body: "オイル量・締付トルクなどをすぐ確認できます。この光っているボタンをタップ。" },
    { sel: "#specList", also: "#btnSpecAI", step: "STEP 3 / 6", title: "諸元が即表示", body: "調べ物の時間を短縮。分からないことは「メカ君に聞く」でAIにも質問できます。若手や外国人スタッフでもすぐ戦力に。" },
    { sel: "diag-nav", nav: true, step: "STEP 4 / 6", title: "故障診断を開く", body: "下のメニューの「🩺 診断」をタップ。" },
    { sel: "#diagText", fill: "P0401", step: "STEP 4 / 6", title: "症状やコードを入力", body: "例として「P0401」を入力しました。実際はダイアグコードや「エンストする」等の症状でOK。次に下の〔メカ君に聞く〕を押します。" },
    { sel: "#btnDiagRun", action: true, result: "#diagResults", step: "STEP 4 / 6", title: "AIに診断させる", body: "「メカ君に聞く」を押すと、考えられる原因・確認手順・対処が表示されます（デモはサンプル）。押して結果を見てみましょう。" },
    { sel: "parts-nav", nav: true, step: "STEP 5 / 6", title: "修理（部品・注文）を開く", body: "続いて「🛠 修理」をタップ。必要部品の洗い出しや注文リスト作成ができます。" },
    { sel: "#qVehText", fill: "ブレーキパッド交換", step: "STEP 5 / 6", title: "作業名を入れるだけでOK", body: "例として「ブレーキパッド交換」を入力しました。次に〔メカ君に聞く〕を押します。" },
    { sel: "#btnVehAsk", action: true, result: "#qVehResult", step: "STEP 5 / 6", title: "必要部品・手順を出す", body: "押すと、必要な部品や作業手順の目安が表示されます（デモはサンプル）。押して結果を見てみましょう。" },
    { sel: "karte-nav", nav: true, step: "STEP 6 / 6", title: "整備カルテを開く", body: "最後に「📋 カルテ」をタップ。作業内容を記録して社内で共有できます。" },
    { sel: "#btnKarteAdd", also: "#karteList", step: "STEP 6 / 6", title: "作業記録を残して共有", body: "「＋」から作業記録を追加。写真での入力にも対応。担当者ごとに管理でき、引き継ぎもスムーズです。" },
    { center: true, step: "体験おわり", title: "おつかれさまでした！", body: "本番では自社の車両データで、これらがすべて使えます。導入のご相談・無料デモはお気軽にどうぞ。", cta: "閉じる", showApply: true },
  ];

  var i = 0, ov, spot, tip, masks = [], curEl = null, stepDone = false, clickFn = null, revealed = false;

  function build() {
    ov = document.createElement("div"); ov.id = "tourOv";
    for (var k = 0; k < 4; k++) { var m = document.createElement("div"); m.className = "tourMask"; m.addEventListener("click", swallow); masks.push(m); ov.appendChild(m); }
    spot = document.createElement("div"); spot.id = "tourSpot"; spot.style.display = "none";
    tip = document.createElement("div"); tip.id = "tourTip";
    ov.appendChild(spot); ov.appendChild(tip); document.body.appendChild(ov);
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); if (spot && spot.style.display !== "none") { spot.classList.remove("pulse"); void spot.offsetWidth; spot.classList.add("pulse"); } }

  function targetFor(s) {
    if (!s.sel) return null;
    if (s.sel === "diag-nav") return visible('.navBtn[data-go="diag"]') || $("#btnGoDiag");
    if (s.sel === "parts-nav") return visible('.navBtn[data-go="parts"]') || $("#btnGoParts");
    if (s.sel === "karte-nav") return visible('.navBtn[data-go="karte"]') || $("#btnGoKarte");
    return visible(s.sel) || $(s.sel);
  }
  function unionRect(s, el) {
    var r = el.getBoundingClientRect();
    var rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    var also = s.also ? (visible(s.also) || $(s.also)) : null;
    if (also) { var r2 = also.getBoundingClientRect(); rect.left = Math.min(rect.left, r2.left); rect.top = Math.min(rect.top, r2.top); rect.right = Math.max(rect.right, r2.right); rect.bottom = Math.max(rect.bottom, r2.bottom); }
    return rect;
  }
  function layoutMasks(hx, hy, hw, hh) {
    var W = window.innerWidth, H = window.innerHeight;
    // T, B, L, R
    set(masks[0], 0, 0, W, Math.max(0, hy));
    set(masks[1], 0, hy + hh, W, Math.max(0, H - (hy + hh)));
    set(masks[2], 0, hy, Math.max(0, hx), hh);
    set(masks[3], hx + hw, hy, Math.max(0, W - (hx + hw)), hh);
    masks.forEach(function (m) { m.style.display = "block"; });
  }
  function set(el, x, y, w, h) { el.style.left = x + "px"; el.style.top = y + "px"; el.style.width = w + "px"; el.style.height = h + "px"; }
  function fullMask() { set(masks[0], 0, 0, window.innerWidth, window.innerHeight); masks[0].style.display = "block"; for (var k = 1; k < 4; k++) masks[k].style.display = "none"; }

  function place(el, s) {
    var rect = unionRect(s, el);
    var pad = 6;
    var hx = rect.left - pad, hy = rect.top - pad, hw = (rect.right - rect.left) + pad * 2, hh = (rect.bottom - rect.top) + pad * 2;
    spot.style.display = "block";
    spot.classList.toggle("pulse", !!(s.nav || s.action));
    set(spot, hx, hy, hw, hh);
    layoutMasks(hx, hy, hw, hh);
    // ツールチップ配置: 対象の下に置く→入らなければ上→どちらも入らない(対象が画面いっぱい)なら
    // 画面下端に固定して、重要な上部情報に被らないようにする。
    var tipH = tip.offsetHeight || 160, tipW = tip.offsetWidth || 300, VH = window.innerHeight, VW = window.innerWidth;
    var spaceBelow = VH - (hy + hh) - 12, spaceAbove = hy - 12, top;
    if (spaceBelow >= tipH) top = hy + hh + 12;
    else if (spaceAbove >= tipH) top = hy - tipH - 12;
    else top = VH - tipH - 14;   // 上下とも余白なし → 画面下端にピン留め
    tip.style.top = Math.max(8, top) + "px";
    tip.style.left = Math.min(Math.max(12, hx + hw / 2 - tipW / 2), VW - tipW - 12) + "px";
  }
  function reposition() {
    var s = STEPS[i]; if (!s || s.center || !curEl || revealed) return;
    place(curEl, s);
  }

  function unbind() { if (clickFn && curEl) { try { curEl.removeEventListener("click", clickFn); } catch (e) {} } clickFn = null; }
  function advance() { if (stepDone) return; stepDone = true; unbind(); i++; if (i >= STEPS.length) return end(); render(); }

  function render() {
    var s = STEPS[i];
    stepDone = false; revealed = false; unbind(); curEl = null;
    var btns = '<div class="tt-btns">' +
      '<button class="tt-skip" data-act="skip">' + (i > 0 ? "スキップ" : "閉じる") + "</button>" +
      '<span class="tt-spacer"></span>' +
      (s.showApply ? '<a class="tt-next" style="text-decoration:none" href="biz.html">詳細・申込</a>' :
        '<button class="tt-next" data-act="next">' + (s.cta || "次へ") + "</button>") +
      "</div>";
    var hint = (s.nav || s.action) ? '<div class="tt-hint">👆 光っている場所をタップ</div>' : "";
    tip.innerHTML = '<div class="tt-step">' + s.step + "</div><h4>" + s.title + "</h4><p>" + s.body + "</p>" + hint + btns;
    tip.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.act === "skip") return end();
        if (s.nav && curEl) { unbind(); try { curEl.click(); } catch (e) {} setTimeout(advance, 300); }
        else if (s.action && curEl && !revealed) { doAction(); }   // 未実行なら「次へ」で実行して結果を見せる
        else advance();
      };
    });

    if (s.center) { spot.style.display = "none"; fullMask(); tip.className = "center"; tip.style.left = ""; tip.style.top = ""; return; }
    tip.className = "";
    waitForTarget(s, 0);
  }

  function doAction() {   // action: その場で結果表示 → 暗幕を外して結果へフォーカス
    if (revealed) return; revealed = true;
    var s = STEPS[i];
    try { curEl.click(); } catch (e) {}
    var next = tip.querySelector(".tt-next"); if (next) next.textContent = "次へ";
    var hint = tip.querySelector(".tt-hint"); if (hint) hint.remove();
    // 結果が描画されるのを待ってから、暗幕を消して結果を画面内へ
    var tries = 0;
    (function waitResult() {
      var res = s.result ? $(s.result) : null;
      var ready = res && res.offsetParent !== null && (res.textContent || "").trim().length > 4;
      if (ready || tries > 20) {
        // 暗幕・枠を消して全体を見えるように(結果を邪魔しない)
        spot.style.display = "none";
        masks.forEach(function (m) { m.style.display = "none"; });
        if (res) { try { res.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {} }
        tip.className = "pin";
        tip.style.left = ""; tip.style.top = "";
        return;
      }
      tries++; setTimeout(waitResult, 150);
    })();
  }

  function waitForTarget(s, tries) {
    var el = targetFor(s);
    if (el && el.offsetParent !== null) {
      curEl = el;
      if (s.fill) { try { if (!el.value) { el.value = s.fill; el.dispatchEvent(new Event("input", { bubbles: true })); } el.focus({ preventScroll: true }); } catch (e) {} }
      try { el.scrollIntoView({ block: "center", behavior: "auto" }); } catch (e) {}
      setTimeout(function () {
        if (STEPS[i] !== s) return;
        place(el, s);
        if (s.nav) { clickFn = function () { setTimeout(advance, 300); }; el.addEventListener("click", clickFn, { once: true }); }
        else if (s.action) { clickFn = function () { doAction(); }; el.addEventListener("click", clickFn, { once: true }); }
      }, 160);
      // レイアウト確定後にもう一度合わせる(スクロール/フォント読み込みのズレ対策)
      setTimeout(function () { if (STEPS[i] === s && !revealed) place(el, s); }, 450);
      return;
    }
    if (tries < 14) { setTimeout(function () { waitForTarget(s, tries + 1); }, 180); return; }
    spot.style.display = "none"; fullMask(); tip.className = "center"; tip.style.left = ""; tip.style.top = "";
  }

  function end() { unbind(); if (ov) ov.remove(); ov = spot = tip = null; masks = []; curEl = null; ensureReplay(); }
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
        clearInterval(t); ensureReplay();
        var seen = false; try { seen = sessionStorage.getItem("ss_tourDone") === "1"; } catch (e) {}
        if (!seen) { try { sessionStorage.setItem("ss_tourDone", "1"); } catch (e) {} start(); }
      } else if (tries > 40) { clearInterval(t); ensureReplay(); }
    }, 250);
  }
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", function () { if (ov) requestAnimationFrame(reposition); }, true);

  if (document.readyState === "complete") waitAndStart();
  else window.addEventListener("load", waitAndStart);
})();
