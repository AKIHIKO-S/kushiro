// 申込の後日修正フォーム(申込者の確認ページと管理画面で共用)。
// サーバーの getSubmissionEditView が返す view を受け取り、入力欄を組み立て、
// 「変えたところだけ」を editSubmission の形にして返す。差分の最終判定と料金の計算はサーバー側。
// 依存なし・ビルドなし。window.KTTASubEditor に公開する。
// 申込者が入力した文字列はすべて esc() を通してから組み立てる。
(function (root) {
  "use strict";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c];
    });
  }
  function yen(n) { return "¥" + (parseInt(n, 10) || 0).toLocaleString("ja-JP"); }
  function shown(fields, k) { return fields && fields[k] && fields[k] !== "hidden"; }
  // エスケープ済みの組み立て結果を差し込む
  function mount(container, markup) {
    var range = container.ownerDocument.createRange();
    range.selectNodeContents(container);
    container.replaceChildren(range.createContextualFragment(markup));
  }

  // 入力欄1つ。data-k に収集キーを持たせ、収集は DOM から行う(状態を二重に持たない)。
  function input(key, label, value, opts) {
    opts = opts || {};
    var attrs = ' data-k="' + esc(key) + '"' + (opts.disabled ? " disabled" : "");
    var ctl;
    if (opts.checkbox) {
      return '<label class="se-check"><input type="checkbox"' + attrs + (value ? " checked" : "") + "> " + esc(label) + "</label>";
    }
    if (opts.options && opts.options.length) {
      ctl = "<select" + attrs + ">" + (opts.blank ? '<option value="">選択してください</option>' : "") +
        opts.options.map(function (o) {
          var v = typeof o === "object" ? o.value : o, l = typeof o === "object" ? o.label : o;
          return '<option value="' + esc(v) + '"' + (String(v) === String(value) ? " selected" : "") + ">" + esc(l) + "</option>";
        }).join("") + "</select>";
    } else if (opts.textarea) {
      ctl = '<textarea rows="' + (opts.rows || 4) + '"' + attrs + ' placeholder="' + esc(opts.placeholder || "") + '">' + esc(value) + "</textarea>";
    } else {
      ctl = '<input type="' + (opts.type || "text") + '"' + attrs + ' value="' + esc(value) + '" placeholder="' + esc(opts.placeholder || "") + '"' +
        (opts.min != null ? ' min="' + opts.min + '"' : "") + (opts.max != null ? ' max="' + opts.max + '"' : "") + ">";
    }
    return '<div class="se-fld"><label>' + esc(label) + "</label>" + ctl + (opts.hint ? '<div class="se-hint">' + esc(opts.hint) + "</div>" : "") + "</div>";
  }

  function customInput(prefix, c, answers) {
    var v = answers ? answers[c.key] : "";
    if (c.type === "checkbox") return input(prefix + "ans." + c.key, c.label, !!v, { checkbox: true });
    if (c.options && c.options.length) return input(prefix + "ans." + c.key, c.label, v == null ? "" : v, { options: c.options, blank: true });
    return input(prefix + "ans." + c.key, c.label, v == null ? "" : v, { textarea: c.type === "textarea", rows: 2 });
  }

  // 選手1人ぶんの申告(学年・自由項目)。生年月日は表示しない(空=変更なし)。
  function playerExtra(prefix, view, ex) {
    var f = view.form.fields || {};
    var out = "";
    if (shown(f, "grade")) out += input(prefix + "grade", view.form.labels.grade || "学年", (ex && ex.grade) || "");
    (view.form.custom || []).filter(function (c) { return c.scope === "player"; }).forEach(function (c) {
      out += customInput(prefix, c, ex && ex.answers);
    });
    return out;
  }

  function entryBlock(view, e, idx) {
    var events = view.form.events || [];
    var cur = events.filter(function (x) { return x.name === e.event; })[0];
    var fam = cur ? cur.family : null;
    var same = events.filter(function (x) { return fam && x.family === fam; });
    var p = "e" + idx + ".";
    var L = view.form.labels || {};
    var head = '<div class="se-ehead"><b>' + esc(e.event) + "</b>" +
      '<span class="se-fee">' + (e.cancelled ? "取消" : "") + "</span></div>";
    if (!e.editable) {
      return '<div class="se-entry se-locked">' + head + '<div class="se-hint">' +
        esc(e.lock_reason || (e.cancelled ? "取り消し済みです" : "変更できません")) + "</div></div>";
    }
    if (e.cancelled) {
      return '<div class="se-entry">' + head + input(p + "restore", "この出場の取消を戻す", false, { checkbox: true }) + "</div>";
    }
    var body = "";
    if (same.length > 1) {
      body += input(p + "event", "種目", e.event, {
        options: same.map(function (x) { return { value: x.name, label: x.name }; }),
        hint: "同じ形式の種目にだけ変更できます。形式が違う種目は、取り消して申し込み直してください",
      });
    }
    var cats = (cur && cur.categories) || [];
    if (cats.length) body += input(p + "division", "区分", e.division || "", { options: cats, blank: true });
    var ex = e.extra_json || {};
    if (e.type === "team") {
      body += input(p + "team_name", "チーム名", e.team_name || "");
      body += input(p + "members", "メンバー（1行に1人）", (e.members || []).join("\n"), {
        textarea: true, rows: 6,
        hint: cur && cur.per_team ? ("最大" + cur.per_team + "人" + (cur.per_team_min ? "・最少" + cur.per_team_min + "人" : "")) : "",
      });
    } else if (e.type === "doubles" || e.type === "mixed") {
      var ps = Array.isArray(ex.players) ? ex.players : [];
      [1, 2].forEach(function (n) {
        body += '<div class="se-slot"><div class="se-slot-h">選手' + n + "</div>" +
          input(p + "name" + n, "氏名", e["name" + n] || "") +
          (shown(view.form.fields, "furigana") ? input(p + "furigana" + n, L.furigana || "ふりがな", e["furigana" + n] || "") : "") +
          input(p + "team" + n, L.player_team || "所属", e["team" + n] || "") +
          playerExtra(p + "pl" + (n - 1) + ".", view, ps[n - 1] || {}) + "</div>";
      });
    } else {
      body += input(p + "name", "氏名", e.name || "");
      if (shown(view.form.fields, "furigana")) body += input(p + "furigana", L.furigana || "ふりがな", e.furigana || "");
      body += input(p + "team", L.player_team || "所属", e.team || "");
      body += playerExtra(p + "x.", view, ex);
    }
    body += input(p + "cancel", "この出場を取り消す", false, { checkbox: true });
    return '<div class="se-entry">' + head + body + "</div>";
  }


  // 追加する種目1つぶんの入力欄。キーは a{n}. で始め、既存の出場(e{n}.)と混ざらないようにする。
  function addBlock(view, ev, n) {
    var p = "a" + n + ".";
    var L = view.form.labels || {};
    var body = "";
    if (ev.categories && ev.categories.length) body += input(p + "division", "区分", "", { options: ev.categories, blank: true });
    if (ev.type === "team") {
      body += input(p + "team_name", "チーム名", (view.submission && view.submission.team_name) || "");
      body += input(p + "members", "メンバー（1行に1人）", "", { textarea: true, rows: 5,
        hint: ev.per_team ? ("最大" + ev.per_team + "人" + (ev.per_team_min ? "・最少" + ev.per_team_min + "人" : "")) : "" });
    } else if (ev.type === "doubles" || ev.type === "mixed") {
      [1, 2].forEach(function (k) {
        body += '<div class="se-slot"><div class="se-slot-h">選手' + k + "</div>" +
          input(p + "name" + k, "氏名", "") +
          (shown(view.form.fields, "furigana") ? input(p + "furigana" + k, L.furigana || "ふりがな", "") : "") +
          input(p + "team" + k, L.player_team || "所属", (view.submission && view.submission.team_name) || "") +
          playerExtra(p + "pl" + (k - 1) + ".", view, {}) + "</div>";
      });
    } else {
      body += input(p + "name", "氏名", "");
      if (shown(view.form.fields, "furigana")) body += input(p + "furigana", L.furigana || "ふりがな", "");
      body += input(p + "team", L.player_team || "所属", (view.submission && view.submission.team_name) || "");
      body += playerExtra(p + "x.", view, {});
    }
    return '<div class="se-entry se-new" data-addblock="' + n + '" data-event="' + esc(ev.name) + '">' +
      '<div class="se-ehead"><b>' + esc(ev.name) + '<span class="se-tag">追加</span></b></div>' +
      body + '<button type="button" class="se-rm" data-addrm="' + n + '">この追加をやめる</button></div>';
  }

  function wireAdd(container, view) {
    var pick = container.querySelector("[data-addpick]");
    var list = container.querySelector("[data-addlist]");
    if (!pick || !list) return;
    var seq = 0;
    pick.addEventListener("change", function () {
      var ev = (view.form.events || []).filter(function (x) { return x.name === pick.value; })[0];
      pick.value = "";
      if (!ev) return;
      var range = container.ownerDocument.createRange();
      range.selectNodeContents(list);
      list.appendChild(range.createContextualFragment(addBlock(view, ev, seq++)));
      var blk = list.lastElementChild;
      var first = blk && blk.querySelector("input,select,textarea");
      if (first) first.focus();
    });
    list.addEventListener("click", function (e) {
      var n = e.target && e.target.getAttribute && e.target.getAttribute("data-addrm");
      if (n == null) return;
      var blk = list.querySelector('[data-addblock="' + n + '"]');
      if (blk) blk.parentNode.removeChild(blk);
    });
  }

  function render(container, view, opts) {
    opts = opts || {};
    var admin = !!opts.admin;
    var s = view.submission || {};
    var f = view.form.fields || {};
    var L = view.form.labels || {};
    var html = "";

    html += '<section class="se-sec"><h4>申込者・団体</h4>';
    html += input("c.team_name", L.team_name || "団体名", s.team_name || "");
    html += input("c.contact_name", L.contact_name || "申込責任者", s.contact_name || "");
    if (admin) {
      html += input("c.contact_tel", L.contact_tel || "電話番号", s.contact_tel || "", { type: "tel" });
      html += input("c.contact_email", L.contact_email || "メールアドレス", s.contact_email || "", { type: "email" });
    } else {
      // 電話・メールは伏せ字で見せる。空欄のまま保存すれば今の値のまま(申込番号が漏れても連絡先は読めない)
      html += input("c.contact_tel", L.contact_tel || "電話番号", "", { type: "tel", placeholder: s.contact_tel_masked || "",
        hint: "変える場合だけ入力してください（空欄なら今の番号のまま）" });
      html += input("c.contact_email", L.contact_email || "メールアドレス", "", { type: "email", placeholder: s.contact_email_masked || "",
        hint: "変える場合だけ入力してください（空欄なら今のアドレスのまま）" });
    }
    ["supervisor", "advisor", "coach"].forEach(function (k) {
      if (shown(f, k) || s[k]) html += input("c." + k, L[k] || k, s[k] || "");
    });
    (view.form.custom || []).filter(function (c) { return c.scope !== "player"; }).forEach(function (c) {
      html += customInput("c.", c, s.answers);
    });
    html += "</section>";

    html += '<section class="se-sec"><h4>出場種目</h4>';
    html += (view.entries || []).map(function (e, i) { return entryBlock(view, e, i); }).join("");
    var addable = (view.form.events || []).filter(function (x) { return !x.add_lock; });
    if (addable.length) {
      html += '<div data-addlist></div>' + '<div class="se-fld se-addpick"><label>種目を追加する</label><select data-addpick>' +
        '<option value="">追加する種目を選んでください</option>' +
        addable.map(function (x) { return '<option value="' + esc(x.name) + '">' + esc(x.name) + "</option>"; }).join("") +
        "</select><div class=\"se-hint\">選んだ種目の入力欄が上に出ます。</div></div>";
    } else {
      html += '<div class="se-hint">' + (admin ? "追加できる種目がありません（組合せ作成後の種目は「表を編集」で行ってください）。"
        : "締切後・組合せ作成後は種目を追加できません。大会本部へご連絡ください。") + "</div>";
    }
    html += "</section>";

    var defs = view.form.option_defs || [];
    if (defs.length) {
      var q = {};
      (view.options || []).forEach(function (o) { q[o.key] = o.qty; });
      html += '<section class="se-sec"><h4>お弁当・懇親会など</h4>';
      html += defs.map(function (d) {
        return input("o." + d.key, d.label + (d.unit ? "（" + d.unit + "）" : ""), q[d.key] || 0,
          { type: "number", min: 0, max: d.max || 999, disabled: !view.can_edit_options });
      }).join("");
      if (!view.can_edit_options) html += '<div class="se-hint">' + esc(view.closed_reason || "受付が終わっています") + "。数の変更は大会本部へご連絡ください。</div>";
      html += "</section>";
    }

    html += '<section class="se-sec">' + input("reason", "修正の理由（任意）", "", { placeholder: admin ? "例: 電話で依頼あり" : "例: 記入ミスのため" }) + "</section>";
    mount(container, '<div class="se">' + html + "</div>");
    wireAdd(container, view);
    container._seView = view;
    container._seInitial = collectRaw(container);
  }

  function collectRaw(container) {
    var out = {};
    var els = container.querySelectorAll("[data-k]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (/^a\d+\./.test(el.getAttribute("data-k"))) continue;
      out[el.getAttribute("data-k")] = el.type === "checkbox" ? !!el.checked : String(el.value == null ? "" : el.value).trim();
    }
    return out;
  }

  // 変えたところだけを editSubmission の形にする。何も変わっていなければ null。
  function collect(container) {
    var view = container._seView, init = container._seInitial || {};
    var now = collectRaw(container);
    var changed = function (k) { return init[k] !== now[k]; };
    var payload = { reason: now.reason || "" };
    var any = false;

    var contact = {}, cAny = false;
    Object.keys(now).forEach(function (k) {
      if (k.indexOf("c.") !== 0 || !changed(k)) return;
      cAny = true;
      var key = k.slice(2);
      if (key.indexOf("ans.") === 0) { contact.answers = contact.answers || {}; contact.answers[key.slice(4)] = now[k]; }
      else contact[key] = now[k];
    });
    if (cAny) { payload.contact = contact; any = true; }

    if (Object.keys(now).some(function (k) { return k.indexOf("o.") === 0 && changed(k); })) {
      payload.options = {};
      Object.keys(now).forEach(function (k) { if (k.indexOf("o.") === 0) payload.options[k.slice(2)] = parseInt(now[k], 10) || 0; });
      any = true;
    }

    var entries = [];
    (view.entries || []).forEach(function (e, i) {
      var p = "e" + i + ".";
      var keys = Object.keys(now).filter(function (k) { return k.indexOf(p) === 0; });
      if (!keys.some(changed)) return;
      if (now[p + "cancel"]) { entries.push({ entrant_id: e.entry_id, cancel: true }); return; }
      if (now[p + "restore"]) { entries.push({ entrant_id: e.entry_id, restore: true }); return; }
      var r = { entrant_id: e.entry_id };
      keys.forEach(function (k) {
        if (!changed(k)) return;
        var sub = k.slice(p.length);
        if (sub === "members") {
          var names = now[k].split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
          r.members = names;
          // メンバーごとの詳細(学年など)を持っている申込は、名前の並びに合わせて詳細も組み直す
          var det = e.extra_json && Array.isArray(e.extra_json.members) ? e.extra_json.members : null;
          if (det) {
            r.extra = r.extra || {};
            r.extra.members = names.map(function (n) { return det.filter(function (d) { return d && d.name === n; })[0] || { name: n }; });
          }
        } else if (sub.indexOf("x.") === 0) {
          var xk = sub.slice(2);
          r.extra = r.extra || {};
          if (xk.indexOf("ans.") === 0) { r.extra.answers = r.extra.answers || {}; r.extra.answers[xk.slice(4)] = now[k]; }
          else r.extra[xk] = now[k];
        } else if (/^pl[01]\./.test(sub)) {
          var pi = parseInt(sub.charAt(2), 10), pk = sub.slice(4);
          r.extra = r.extra || {};
          r.extra.players = r.extra.players || [];
          var slot = r.extra.players[pi] = r.extra.players[pi] || {};
          if (pk.indexOf("ans.") === 0) { slot.answers = slot.answers || {}; slot.answers[pk.slice(4)] = now[k]; }
          else slot[pk] = now[k];
        } else if (sub !== "cancel" && sub !== "restore") {
          r[sub] = now[k];
        }
      });
      if (r.extra && r.extra.players) for (var j = 0; j < 2; j++) if (!r.extra.players[j]) r.extra.players[j] = {};
      entries.push(r);
    });
    if (entries.length) { payload.entries = entries; any = true; }

    var adds = [];
    var blocks = container.querySelectorAll("[data-addblock]");
    for (var b = 0; b < blocks.length; b++) {
      var blk = blocks[b], ap = "a" + blk.getAttribute("data-addblock") + ".";
      var a = { event: blk.getAttribute("data-event") }, ex = {};
      var els = blk.querySelectorAll("[data-k]");
      for (var q = 0; q < els.length; q++) {
        var el = els[q], sub = el.getAttribute("data-k").slice(ap.length);
        var v = el.type === "checkbox" ? !!el.checked : String(el.value == null ? "" : el.value).trim();
        if (sub === "members") a.members = v.split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
        else if (sub.indexOf("x.") === 0) {
          var xk = sub.slice(2);
          if (xk.indexOf("ans.") === 0) { ex.answers = ex.answers || {}; ex.answers[xk.slice(4)] = v; } else ex[xk] = v;
        } else if (/^pl[01]\./.test(sub)) {
          var pi = parseInt(sub.charAt(2), 10), pk = sub.slice(4);
          ex.players = ex.players || [{}, {}];
          if (pk.indexOf("ans.") === 0) { ex.players[pi].answers = ex.players[pi].answers || {}; ex.players[pi].answers[pk.slice(4)] = v; }
          else ex.players[pi][pk] = v;
        } else a[sub] = v;
      }
      if (Object.keys(ex).length) a.extra_json = ex;
      adds.push(a);
    }
    if (adds.length) { payload.add = adds; any = true; }
    return any ? payload : null;
  }

  // 両画面に同じ見た目を当てる最小のCSS(各画面の色変数があればそれを使う)
  var CSS = ".se-sec{margin:0 0 18px}.se-sec h4{font-size:14px;font-weight:800;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line,#e4dccb)}" +
    ".se-fld{margin:0 0 10px}.se-fld label{display:block;font-size:12.5px;font-weight:700;color:var(--ink-2,#6c6153);margin-bottom:4px}" +
    ".se-fld input,.se-fld select,.se-fld textarea{width:100%;box-sizing:border-box;padding:10px 11px;border:1.5px solid var(--line,#e4dccb);border-radius:8px;font-size:16px;font-family:inherit;background:#fff;color:inherit}" +
    ".se-fld input:disabled{background:#f3f0ea}.se-hint{font-size:12px;color:var(--ink-2,#6c6153);margin-top:4px;line-height:1.6}" +
    ".se-check{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;min-height:44px;cursor:pointer}.se-check input{width:20px;height:20px;margin:0}" +
    ".se-entry{border:1px solid var(--line,#e4dccb);border-radius:10px;padding:12px;margin-bottom:10px;background:#fff}.se-locked{opacity:.75}" +
    ".se-ehead{display:flex;justify-content:space-between;gap:8px;margin-bottom:8px}.se-fee{font-variant-numeric:tabular-nums;font-weight:700;white-space:nowrap}" +
    ".se-new{border-color:var(--ink-2,#6c6153)}.se-tag{display:inline-block;margin-left:8px;font-size:11px;font-weight:800;padding:1px 7px;border-radius:999px;background:var(--line,#e4dccb)}" +
    ".se-rm{margin-top:4px;min-height:44px;padding:0 12px;border:1px solid var(--line,#e4dccb);border-radius:8px;background:#fff;font:inherit;font-size:13px;cursor:pointer;color:inherit}" +
    ".se-addpick select{border-style:dashed}" +
    ".se-slot{border-top:1px dashed var(--line,#e4dccb);padding-top:8px;margin-top:6px}.se-slot-h{font-size:12px;font-weight:800;margin-bottom:6px}";
  function injectCss(doc) {
    doc = doc || root.document;
    if (!doc || doc.getElementById("se-css")) return;
    var st = doc.createElement("style"); st.id = "se-css"; st.textContent = CSS;
    doc.head.appendChild(st);
  }

  root.KTTASubEditor = { render: render, collect: collect, injectCss: injectCss, yen: yen, esc: esc };
})(typeof window !== "undefined" ? window : this);
