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
  // ※以前はここで「デモでなければ即return」していたが、それだと window.mechaStartTour が定義されず、
  //   ログインゲートの「デモを試す」から入った時にガイドが起動しなかった。
  //   関数群は常に定義し、"自動開始"だけを末尾でデモ時のみ行う。

  var $ = function (s) { return document.querySelector(s); };
  function visible(sel) {
    var els = document.querySelectorAll(sel);
    for (var i = 0; i < els.length; i++) { if (els[i].offsetParent !== null) return els[i]; }
    return null;
  }

  // 種別: center=中央説明 / (既定)=説明のみ / nav=タップで画面遷移(自動で次へ) /
  //       action=タップでその場に結果表示(次へで進む) / fill=例文を入れて誘導
  //       ch=章番号(同じ章が続く間は「(2/3)」と小番号を自動で付ける)
  //       after=action実行後に吹き出しを差し替える文言
  var STEPS = [
    { center: true, step: "体験モード", title: "メカノAIを触ってみましょう", body: "実際の画面で操作感を体験できます（サンプルの軽バンを読み込み済み・AIはサンプル応答）。光っている場所をタップして進めてください。", cta: "はじめる" },
    { sel: "#result", ch: 1, title: "車検証を読むと車両情報が出ます", body: "本番では車検証のQR・写真を撮るだけ。今回はサンプル車両（ダイハツ ハイゼットカーゴ）を読み込んでいます。" },
    { sel: "#btnGoMaint", nav: true, ch: 2, title: "メンテナンス諸元を見る", body: "オイル量・締付トルクなどをすぐ確認できます。この光っているボタンをタップ。" },
    { sel: "#specList", also: "#btnSpecAI", ch: 3, title: "諸元が即表示", body: "調べ物の時間を短縮。分からないことは「メカ君に聞く」でAIにも質問できます。若手や外国人スタッフでもすぐ戦力に。" },
    { sel: "diag-nav", nav: true, ch: 4, title: "故障診断を開く", body: "上に並んだメニューから「🩺 診断」をタップ。" },
    { sel: "#diagText", fill: "P0401", ch: 4, title: "症状やコードを入力", body: "例として「P0401」を入力しました。実際はダイアグコードや「エンストする」等の症状でOK。" },
    { sel: "#btnDiagRun", action: true, result: "#diagResults", ch: 4, title: "AIに診断させる", body: "「メカ君に聞く」を押すと、原因候補が可能性の高い順に出ます（デモはサンプル回答）。",
      after: { title: "原因候補が出ました", body: "スクロールすると、理由・切り分け方・改善の見込みを確認できます。" } },
    { sel: "parts-nav", nav: true, ch: 5, title: "修理（部品・注文）を開く", body: "続いて上のメニューの「🛠 修理」をタップ。必要部品の洗い出しや注文リスト作成ができます。" },
    { sel: "#qVehText", fill: "ブレーキパッド交換", ch: 5, title: "作業名を入れるだけでOK", body: "例として「ブレーキパッド交換」を入力しました。" },
    { sel: "#btnVehAsk", action: true, result: "#qVehResult", ch: 5, title: "必要部品・手順を出す", body: "「メカ君に聞く」を押すと、必要な部品や作業手順の目安が出ます（デモはサンプル回答）。",
      after: { title: "手順とトルクが出ました", body: "見出しをタップすると、部品リスト・交換手順・締付トルクが開きます。" } },
    { sel: "karte-nav", nav: true, ch: 6, title: "整備カルテを開く", body: "上のメニューの「📋 カルテ」をタップ。作業内容を記録できます。" },
    { sel: "#btnKarteAdd", also: "#karteList", ch: 6, title: "作業記録を残す", body: "右上のボタンから作業記録を追加。伝票やメモの写真からの入力にも対応しています。" },
    { sel: "home-tab", nav: true, ch: 7, title: "入庫状況を見る（Works）", body: "最後に「📷 スキャン」をタップしてホームへ。ここからは法人版 Works の機能です。" },
    { sel: "#homeIntake", openFold: true, ch: 7, title: "入庫中の車両がひと目で（Works）", body: "入庫区分（車検・点検・修理・板金）を選んだ車両がここに並び、社内の全端末で共有されます。ガイドを閉じたあと、見出しの📅で入出庫カレンダーも開けます。" },
    { center: true, step: "体験おわり", title: "おつかれさまでした！", body: "このままデモを自由に触れます。入庫状況・カレンダー・社内共有は法人版 Works の機能です。個人版 Pocket は、スキャン・諸元・診断・修理・カルテを自分のスマホ1台で使えます。", showApply: true },
  ];
  var CH_TOTAL = STEPS.reduce(function (m, s) { return Math.max(m, s.ch || 0); }, 0);
  function stepLabel(idx) {
    var s = STEPS[idx];
    if (!s.ch) return s.step || "";
    var same = STEPS.filter(function (x) { return x.ch === s.ch; });
    var sub = same.length > 1 ? '<span class="tt-sub">（' + (same.indexOf(s) + 1) + "/" + same.length + "）</span>" : "";
    return "STEP " + s.ch + " / " + CH_TOTAL + sub;
  }

  var i = 0, ov, spot, tip, masks = [], curEl = null, stepDone = false, clickFn = null, revealed = false, tick = null;

  function build() {
    ov = document.createElement("div"); ov.id = "tourOv";
    for (var k = 0; k < 4; k++) { var m = document.createElement("div"); m.className = "tourMask"; m.addEventListener("click", swallow); masks.push(m); ov.appendChild(m); }
    spot = document.createElement("div"); spot.id = "tourSpot"; spot.style.display = "none";
    tip = document.createElement("div"); tip.id = "tourTip";
    ov.appendChild(spot); ov.appendChild(tip); document.body.appendChild(ov);
    // 文字入力や描画の遅れで対象が後から動いても、枠と暗幕が置き去りにならないよう定期的に合わせ直す
    tick = setInterval(reposition, 300);
  }
  function swallow(e) { e.preventDefault(); e.stopPropagation(); if (spot && spot.style.display !== "none") { spot.classList.remove("pulse"); void spot.offsetWidth; spot.classList.add("pulse"); } }

  function targetFor(s) {
    if (!s.sel) return null;
    if (s.sel === "diag-nav") return visible('.navBtn[data-go="diag"]') || $("#btnGoDiag");
    if (s.sel === "parts-nav") return visible('.navBtn[data-go="parts"]') || $("#btnGoParts");
    if (s.sel === "karte-nav") return visible('.navBtn[data-go="karte"]') || $("#btnGoKarte");
    if (s.sel === "home-tab") return visible('nav#tabs button[data-view="scan"]');
    return visible(s.sel) || $(s.sel);
  }
  function unionRect(s, el) {
    var r = el.getBoundingClientRect();
    var rect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    // 補助要素は「実際に表示されていて大きさがある」時だけ囲む(非表示要素の0,0を巻き込まない)
    var also = s.also ? visible(s.also) : null;
    if (also) {
      var r2 = also.getBoundingClientRect();
      if (r2.width > 0 && r2.height > 0) { rect.left = Math.min(rect.left, r2.left); rect.top = Math.min(rect.top, r2.top); rect.right = Math.max(rect.right, r2.right); rect.bottom = Math.max(rect.bottom, r2.bottom); }
    }
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
    // ツールチップ配置:
    //  ① 対象の横(左右)に十分な余白があれば、その余白側に縦中央で置く(PCの広い画面向き)
    //  ② なければ 下 → 上 → どちらも入らなければ画面下端にピン留め(モバイルの縦長対象向き)
    var tipH = tip.offsetHeight || 160, tipW = tip.offsetWidth || 300, VH = window.innerHeight, VW = window.innerWidth;
    var clamp = function (v, lo, hi) { return Math.min(Math.max(v, lo), hi); };
    var gutterL = hx, gutterR = VW - (hx + hw), top, left;
    if (gutterR >= tipW + 24) { left = hx + hw + 16; top = clamp(hy + hh / 2 - tipH / 2, 8, VH - tipH - 8); }
    else if (gutterL >= tipW + 24) { left = hx - tipW - 16; top = clamp(hy + hh / 2 - tipH / 2, 8, VH - tipH - 8); }
    else {
      if (VH - (hy + hh) - 12 >= tipH) top = hy + hh + 12;
      else if (hy - 12 >= tipH) top = hy - tipH - 12;
      else top = VH - tipH - 14;
      top = Math.max(8, top);
      left = clamp(hx + hw / 2 - tipW / 2, 12, VW - tipW - 12);
    }
    tip.style.top = top + "px";
    tip.style.left = left + "px";
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
    var last = i === STEPS.length - 1;
    if (last && window.mechaTrack) { try { window.mechaTrack("demo_done"); } catch (e) {} }   // ガイドを最後まで進めた回数(track.js)
    // 最後の画面は行き先を2つ出す(個人=Pocketの無料登録 / 会社=Worksの案内)。縦に並べて押し間違えないように。
    var btns = s.showApply
      ? '<div class="tt-ends">' +
          '<button class="tt-next" data-act="pocket">個人で使う（7日間無料）</button>' +
          '<a class="tt-next tt-alt" href="biz.html">会社で導入する（詳細・申込）</a>' +
          '<button class="tt-skip" data-act="skip">閉じる</button>' +
        "</div>"
      : '<div class="tt-btns">' +
          '<button class="tt-skip" data-act="skip">' + (i > 0 && !last ? "スキップ" : "閉じる") + "</button>" +
          '<span class="tt-spacer"></span>' +
          '<button class="tt-next" data-act="next">' + (s.cta || "次へ") + "</button>" +
        "</div>";
    var hint = (s.nav || s.action) ? '<div class="tt-hint">👆 光っている場所をタップ</div>' : "";
    var prog = '<div class="tt-prog"><i style="width:' + Math.round(i / (STEPS.length - 1) * 100) + '%"></i></div>';
    tip.innerHTML = prog + '<div class="tt-step">' + stepLabel(i) + "</div><h4>" + s.title + "</h4><p>" + s.body + "</p>" + hint + btns;
    tip.querySelectorAll("[data-act]").forEach(function (b) {
      b.onclick = function () {
        if (b.dataset.act === "skip") return end();
        if (b.dataset.act === "pocket") {
          // デモを抜けてから、ログイン画面のPocket無料登録へ(ss_demo が残っているとデモが再開してしまう)
          try { sessionStorage.removeItem("ss_demo"); } catch (e) {}
          location.href = location.pathname + "?pocket=start";
          return;
        }
        if (s.nav && curEl) { unbind(); try { curEl.click(); } catch (e) {} setTimeout(advance, 300); }
        else if (s.action && curEl && !revealed) { doAction(true); }   // 未実行なら「次へ」で実行して結果を見せる
        else advance();
      };
    });

    if (s.center) { spot.style.display = "none"; fullMask(); tip.className = "center"; tip.style.left = ""; tip.style.top = ""; return; }
    tip.className = "";
    waitForTarget(s, 0);
  }

  // action: その場で結果表示 → 暗幕を外して結果へフォーカス。
  // viaTip=吹き出しの「次へ」から来た時だけ、対象ボタンを代わりに押す。
  // 対象を本人がタップした時にも押すと二重実行になり、同じ結果が2件保存されていた。
  function doAction(viaTip) {
    if (revealed) return; revealed = true;
    var s = STEPS[i];
    unbind();
    if (viaTip) { try { curEl.click(); } catch (e) {} }
    var next = tip.querySelector(".tt-next"); if (next) next.textContent = "次へ";
    var hint = tip.querySelector(".tt-hint"); if (hint) hint.remove();
    if (s.after) {
      var h = tip.querySelector("h4"), p = tip.querySelector("p");
      if (h) h.textContent = s.after.title;
      if (p) p.textContent = s.after.body;
    }
    // 結果が描画されるのを待ってから、暗幕を消して結果を画面内へ
    var tries = 0;
    (function waitResult() {
      var res = s.result ? $(s.result) : null;
      var ready = res && res.offsetParent !== null && (res.textContent || "").trim().length > 4;
      if (ready || tries > 20) {
        // 暗幕・枠を消して全体を見えるように(結果を邪魔しない)
        spot.style.display = "none";
        masks.forEach(function (m) { m.style.display = "none"; });
        if (res) { try { res.scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) {} }
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
      // 折りたたみ(details)の中身を見せたいステップは、開いた状態にしてから囲む
      if (s.openFold) { try { var fold = el.querySelector("details"); if (fold) fold.open = true; } catch (e) {} }
      try { el.scrollIntoView({ block: "center", behavior: "auto" }); } catch (e) {}
      setTimeout(function () {
        if (STEPS[i] !== s) return;
        place(el, s);
        if (s.nav) { clickFn = function () { setTimeout(advance, 300); }; el.addEventListener("click", clickFn, { once: true }); }
        else if (s.action) { clickFn = function () { doAction(false); }; el.addEventListener("click", clickFn, { once: true }); }
      }, 160);
      // レイアウト確定後にもう一度合わせる(スクロール/フォント読み込みのズレ対策)
      setTimeout(function () { if (STEPS[i] === s && !revealed) place(el, s); }, 450);
      return;
    }
    if (tries < 14) { setTimeout(function () { waitForTarget(s, tries + 1); }, 180); return; }
    spot.style.display = "none"; fullMask(); tip.className = "center"; tip.style.left = ""; tip.style.top = "";
  }

  function end() { unbind(); if (tick) { clearInterval(tick); tick = null; } if (ov) ov.remove(); ov = spot = tip = null; masks = []; curEl = null; ensureReplay(); }
  function start() { i = 0; if (!ov) build(); render(); }
  // 外部(デモ起動側)からタイミングを合わせて確実に開始できるように公開。
  // force=true で「表示済みフラグ」を無視して開始。表示中(ov有り)なら何もしない(二重起動防止)。
  window.mechaStartTour = function (force) {
    if (ov) return;
    if (!force) { try { if (sessionStorage.getItem("ss_tourDone") === "1") return; } catch (e) {} }
    try { sessionStorage.setItem("ss_tourDone", "1"); } catch (e) {}
    try { ensureReplay(); } catch (e) {}   // 「❓体験ガイド」再生ボタンを常に用意
    start();
  };

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
        // デモUI描画の直後は再レンダリングでオーバーレイが消えることがあるので、少し待ってから開始
        setTimeout(function () { try { window.mechaStartTour(false); } catch (e) {} }, 600);
      } else if (tries > 40) { clearInterval(t); ensureReplay(); }
    }, 250);
  }
  window.addEventListener("resize", reposition);
  window.addEventListener("scroll", function () { if (ov) requestAnimationFrame(reposition); }, true);

  // 自動開始はデモ時のみ(?demo=1 / ss_demo)。ゲートの「デモを試す」経由は app.js の startDemo が
  // mechaStartTour(true) を呼ぶので、ここで未定義にならないよう関数は常に公開しておく。
  if (isDemo()) {
    if (document.readyState === "complete") waitAndStart();
    else window.addEventListener("load", waitAndStart);
  }
})();
