export function initExamEngine() {
    const $ = id => document.getElementById(id);
    const esc = s => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const LS_NAME = 'satbank:name';   // the ONLY identity store: a typed name, no login
    const LS_UI = 'satbank:ui';       // optional UI state: theme/sound/motion + filters/highlight prefs
    // NOTE: legacy keys (satbank:profile:*, exam_all_v1) are NEVER deleted — old
    // solo answers stay on disk untouched. New answers live on the remote sync service.
    let DB = [];
    let S = { answers: {}, marked: [], elim: {}, currentIndex: 0, hl: {}, hlAuto: false, hlColor: 'y', hlU: false, name: '', fDom: [], fDif: [], order: null };
    let idx = 0;
    let F = [];
    const DOMS = ["Information and Ideas", "Craft and Structure", "Expression of Ideas", "Standard English Conventions"];
    const DIFS = ["Easy", "Medium", "Hard"];
    function fMatch(e) {
      const dOk = !S.fDom.length || S.fDom.includes(e.domain);
      const fOk = !S.fDif.length || S.fDif.includes(e.difficulty);
      return dOk && fOk;
    }
    function rebuildF() {
      if (!Array.isArray(S.order) || S.order.length !== DB.length ||
        new Set(S.order).size !== DB.length) S.order = null;
      const base = S.order || DB.map((_, i) => i);
      F = base.filter(i => fMatch(DB[i]));
      if (!F.length) F = base.slice();
      if (CH && CH.length) { // Duo challenge mode: restrict to the assigned set
        F = CH.filter(i => i >= 0 && i < DB.length);
        if (!F.length) F = base.slice();
      }
      if (!F.includes(idx)) idx = F[0];
    }

    /* ── Challenge mode + App bridge (used by backend.js; solo rendering untouched) ── */
    let CH = null; // array of DB indices while a live 1v1 challenge is active, else null
    const BANNER_DEFAULT = 'THIS IS A PRACTICE TEST';
    function setChallenge(idxs, on) {
      CH = (on && idxs && idxs.length) ? idxs.filter(i => i >= 0 && i < DB.length) : null;
      if (CH && CH.length) idx = CH[0];
      rebuildF();
      renderQ();
    }
    function setBanner(t) {
      const bt = $('banner-text');
      if (bt) bt.textContent = t || BANNER_DEFAULT;
      else if ($('banner')) $('banner').textContent = t || BANNER_DEFAULT;
    }
    function jumpToQid(qid) {
      const i = DB.findIndex(e => e && e.id === qid);
      if (i < 0) return;
      if (CH && !CH.includes(i)) setChallenge(null); // reviewing outside the set exits challenge view
      goTo(i);
    }
    function persist() { save(); }
    function refreshUI() {
      idx = Math.min(Math.max(S.currentIndex || 0, 0), Math.max(DB.length - 1, 0));
      rebuildF(); renderQ(); syncName(); syncFilterUI(); syncShuffleBtn();
    }
    // Identity = typed name only. Switching names swaps nothing on disk (answers
    // are per-name on the remote sync service); it just clears in-memory answers for the view.
    function setIdentity(name) {
      S.answers = {}; S.currentIndex = 0; idx = 0;
      CH = null; setBanner(null);
      load();
      S.name = name || '';
      refreshUI();
    }
    window.App = {
      get DB() { return DB; }, get S() { return S; },
      get idx() { return idx; }, get F() { return F; },
      setChallenge, banner: setBanner, jumpToQid, goTo, renderQ, cur,
      persist, refresh: refreshUI, setIdentity,
      recordLocalAnswer(qid, letter, correct) {
        // In-memory + immediate paint. Net layer persists to the remote sync service after.
        S.answers[qid] = letter;
        save(); renderQ();
      },
    };
    function fPos() { const p = F.indexOf(idx); return p < 0 ? 0 : p; }
    function syncShuffleBtn() {
      const on = !!S.order;
      $('mm-shuffle').classList.toggle('on', on);
      $('mm-shuffle').textContent = on ? 'Unshuffle' : 'Shuffle';
    }
    $('mm-shuffle').addEventListener('click', () => {
      $('moreMenu').classList.remove('open');
      if (S.order) {
        S.order = null;
      } else {
        const a = DB.map((_, i) => i);
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        S.order = a;
      }
      save(); rebuildF();
      idx = F[0];
      renderQ(); syncShuffleBtn();
    });

    function save() {
      // localStorage holds ONLY name + UI prefs. Answers live on the remote sync service
      // (S.answers in memory). Legacy answer keys are left untouched on disk.
      try {
        localStorage.setItem(LS_NAME, S.name || '');
        localStorage.setItem(LS_UI, JSON.stringify({
          fDom: S.fDom, fDif: S.fDif, order: S.order,
          hlAuto: S.hlAuto, hlColor: S.hlColor,
        }));
      } catch (e) { }
    }
    function load() {
      try {
        S.name = (localStorage.getItem(LS_NAME) || '').slice(0, 20);
        const u = JSON.parse(localStorage.getItem(LS_UI) || 'null') || {};
        if (Array.isArray(u.fDom)) S.fDom = u.fDom.filter(x => DOMS.includes(x));
        if (Array.isArray(u.fDif)) S.fDif = u.fDif.filter(x => DIFS.includes(x));
        if (u.order === null || Array.isArray(u.order)) S.order = u.order;
        if (typeof u.hlAuto === 'boolean') S.hlAuto = u.hlAuto;
        if (typeof u.hlColor === 'string') S.hlColor = u.hlColor;
        S.hlU = false;
      } catch (e) { }
    }
    function cur() { return DB[idx]; }

    /* ── Passage / stem split: task sentence goes right, rest goes left ── */
    function splitQA(text) {
      const studentIdx = text.indexOf('The student wants');
      if (studentIdx !== -1 && text.includes('taken the following notes')) {
        return {
          passage: text.slice(0, studentIdx).trim(),
          stem: text.slice(studentIdx).trim()
        };
      }
      const parts = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/);
      const TASK = /^(Which|What|How|Why|Based on|According to|The student|The author)\b/;
      if (parts.length > 1) {
        const last = parts[parts.length - 1].trim();
        if (TASK.test(last) || /\?$/.test(last))
          return { passage: parts.slice(0, -1).join(' '), stem: last };
      }
      return { passage: text, stem: 'Select the best answer.' };
    }
    /* Plain-text offset of the split (for mapping <u> ranges to each side) */
    function splitBound(plain, stem) {
      if (stem === 'Select the best answer.') return plain.length;
      const i = plain.lastIndexOf(stem);
      return i < 0 ? plain.length : i;
    }
    /* DB strings carry <u> from the PDF's underlined text: helpers */
    function stripU(s) { return (s || '').replace(/<\/?u>/g, ''); }
    function fmtU(s) { return esc(s).replace(/&lt;(\/?u)&gt;/g, '<$1>'); }
    function uRanges(tagged) {
      const ranges = [];
      let p = 0, i = 0, st = -1;
      const s = tagged || '';
      while (i < s.length) {
        if (s.startsWith('<u>', i)) { if (st < 0) st = p; i += 3; }
        else if (s.startsWith('</u>', i)) { if (st >= 0) { ranges.push([st, p]); st = -1; } i += 4; }
        else { p++; i++; }
      }
      if (st >= 0) ranges.push([st, p]);
      return ranges;
    }
    function clipRanges(ranges, lo, hi) {
      const out = [];
      for (const [s, e] of ranges) {
        if (e <= lo || s >= hi) continue;
        out.push([Math.max(s, lo), Math.min(e, hi)]);
      }
      return out;
    }

    /* ── Render one full Bluebook page ── */
    let hlPopNew = -1;
    function hlList(qid, w) { return (S.hl[qid] || []).filter(h => h.w === w).sort((a, b) => a.s - b.s); }
    function hlHTML(text, list, popIdx, ur) {
      // text is plain (no tags); ur = [[s,e]] underline ranges in the same coords.
      // <mark> wraps <u> per atom so partial overlaps stay valid HTML.
      const cuts = new Set([0, text.length]);
      for (const h of list) {
        cuts.add(Math.max(0, h.s)); cuts.add(Math.min(text.length, h.e));
      }
      for (const [s, e] of (ur || [])) {
        cuts.add(Math.max(0, s)); cuts.add(Math.min(text.length, e));
      }
      const pts = [...cuts].sort((a, b) => a - b);
      const byQ = S.hl[cur().id] || [];
      const hlAt = p => list.find(h => p >= Math.max(0, h.s) && p < Math.min(text.length, h.e));
      const uAt = p => (ur || []).some(([s, e]) => p >= s && p < e);
      let out = '';
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k], b = pts[k + 1];
        if (b <= a) continue;
        const atom = esc(text.slice(a, b));
        const h = hlAt(a), u = uAt(a);
        const inner = u ? `<u>${atom}</u>` : atom;
        if (h && h.e > h.s) {
          const qi = byQ.indexOf(h);
          const pop = qi === popIdx ? ' hl-pop' : '';
          const note = h.n ? ` title="${esc(h.n)}"` : '';
          out += `<mark class="hl hl-${h.c}${h.u ? ' hl-u' : ''}${pop}" data-hl="${qi}"${note}>${inner}</mark>`;
        } else {
          out += inner;
        }
      }
      return out;
    }
    function renderQ() {
      // Duel lock: every render snaps back to the live battle question —
      // Back/Next, keys, search jumps and navigator can't leave it.
      if (window.Net && Net.clampNav) idx = Net.clampNav(idx);
      const e = cur();
      const plainQ = stripU(e.question);
      const parts = splitQA(plainQ);
      const bound = splitBound(plainQ, parts.stem);
      const ranges = uRanges(e.question);
      const pUR = clipRanges(ranges, 0, parts.passage.length);
      const sUR = clipRanges(ranges, bound, plainQ.length).map(([s, e2]) => [s - bound, e2 - bound]);
      S.currentIndex = idx;
      const pos = fPos(), total = F.length;
      const qbn = String(pos + 1), qb = $('qbadge');
      qb.textContent = qbn;
      // Long numbers shrink + widen to fit; 1–2 digits render exactly as before.
      qb.style.fontSize = qbn.length >= 4 ? "11px" : qbn.length >= 3 ? "13px" : "";
      qb.style.width = qbn.length >= 3 ? "auto" : "";
      qb.style.padding = qbn.length >= 3 ? "0 7px" : "";
      $('difftag').textContent = e.difficulty || '';
      $('markbtn').classList.toggle('marked', S.marked.includes(e.id));
      const all = S.hl[e.id] || [];
      const plist = all.filter(h => h.w === 'p').sort((a, b) => a.s - b.s);
      const slist = all.filter(h => h.w === 's').sort((a, b) => a.s - b.s);
      $('passage').classList.toggle('notes-mode', parts.passage.includes('•'));
      $('passage').innerHTML = hlHTML(parts.passage, plist, hlPopNew, pUR) +
        (e.fig ? `<img class="figimg" src="${e.fig}" alt="Figure">` : '');
      $('stem').innerHTML = hlHTML(parts.stem, slist, hlPopNew, sUR);
      hlPopNew = -1;
      const isRush = window.Net && Net.inRush && Net.inRush();
      const ans = isRush ? (Net.rushLocalAnswers && Net.rushLocalAnswers[e.id]) : S.answers[e.id];
      const elim = S.elim[e.id] || [];
      $('opts').innerHTML = ['A', 'B', 'C', 'D'].filter(k => e.choices[k]).map(k => {
        let cls = 'opt';
        if (ans) {
          if (isRush) {
            if (k === ans) cls += ' picked';
          } else {
            cls += ' locked';
            if (k === e.correct) cls += ' correct';
            else if (k === ans) cls += ' wrongpick';
          }
        }
        if (elim.includes(k)) cls += ' eliminated';
        return `<div class="optrow"><div class="${cls}" data-k="${k}" role="button" tabindex="0">` +
          `<span class="letter">${k}</span><span class="opttxt">${fmtU(e.choices[k])}</span></div>` +
          `<button class="elim${elim.includes(k) ? ' on' : ''}" data-k="${k}" title="Eliminate choice">${k}</button></div>`;
      }).join('');
      if (isRush) {
        $('expbar').className = '';
        $('expbar').innerHTML = '';
        $('exptext').innerHTML = '';
        $('exptext').className = '';
      } else {
        $('expbar').className = ans ? 'show' : '';
        if (ans) {
          $('expbar').innerHTML = `<span class="${ans === e.correct ? 'ok' : 'no'}">` +
            `${ans === e.correct ? 'Correct' : 'Incorrect'} — answer ${e.correct}</span>` +
            `<button id="expbtn">Why?</button>`;
          $('exptext').innerHTML = `${fmtU(e.rationale)}<div class="pg">answers.pdf p.${e.a_page}</div>`;
          $('exptext').className = '';
        } else {
          $('expbar').innerHTML = '';
          $('exptext').innerHTML = '';
          $('exptext').className = '';
        }
      }
      $('navpill').innerHTML = `Question ${pos + 1} <svg width="11" height="7" viewBox="0 0 11 7" style="vertical-align:1px"><path d="M1 5.8L5.5 1.5 10 5.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      $('backbtn').disabled = pos === 0;
      $('nextbtn').disabled = pos === total - 1;
      $('left').scrollTop = 0; $('right').scrollTop = 0;
      // Duel decor: lock options, neutral pick / simultaneous reveal, nav lock.
      if (window.Net && Net.decorate) Net.decorate();
      save();
    }
    function goTo(i) {
      if (!F.length) return;
      if (F.includes(i)) idx = i;
      else {
        let best = F[0], bd = Math.abs(i - best);
        for (const j of F) { const d = Math.abs(i - j); if (d < bd) { bd = d; best = j; } }
        idx = best;
      }
      renderQ();
      if (window.Net && Net.moved) Net.moved(idx); // live status: currentQuestionId
    }
    function stepQ(d) {
      const p = fPos() + d;
      if (p < 0 || p >= F.length) return;
      idx = F[p];
      renderQ();
      if (window.Net && Net.moved) Net.moved(idx); // live status: currentQuestionId
    }
    $('backbtn').addEventListener('click', () => stepQ(-1));
    $('nextbtn').addEventListener('click', () => stepQ(1));

    $('opts').addEventListener('click', ev => {
      const e = cur();
      const el = ev.target.closest('.elim');
      if (el) {
        if (S.answers[e.id]) return;
        const k = el.dataset.k;
        S.elim[e.id] = S.elim[e.id] || [];
        const at = S.elim[e.id].indexOf(k);
        if (at >= 0) S.elim[e.id].splice(at, 1); else S.elim[e.id].push(k);
        save(); renderQ(); return;
      }
      const opt = ev.target.closest('.opt');
      if (!opt) return;
      const k = opt.dataset.k;
      // Challenge mode intercepts: locks input, writes session answer, reveals on both.
      if (window.Net && Net.inChallenge && Net.inChallenge()) {
        if (Net.inRush && Net.inRush()) {
          Net.recordRushAnswer(e.id, k);
          return;
        }
        Net.answerChallenge(e.id, k);
        return;
      }
      if (S.answers[e.id]) return;
      S.answers[e.id] = k;
      S.elim[e.id] = (S.elim[e.id] || []).filter(x => x !== k);
      save(); renderQ();
      try {
        window.dispatchEvent(new CustomEvent('satbank:answer', { detail: { qid: e.id, selected: k, correct: e.correct } }));
      } catch (err) {}
      // Solo answer -> remote attempt ledger (replaces old localStorage answer saving).
      if (window.Net && Net.recordAnswer) Net.recordAnswer(e.id, k, null);
      try { // juicy feedback: pop/shake + blip (skipped for reduced-motion users)
        const reduce = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
        const good = document.querySelector('#opts .opt.correct');
        const bad = document.querySelector('#opts .opt.wrongpick');
        if (!reduce && good && good.animate) {
          if (k === e.correct) good.animate(
            [{ transform: "scale(1)" }, { transform: "scale(1.045)" }, { transform: "scale(1)" }],
            { duration: 280, easing: "cubic-bezier(.2,1.6,.4,1)" });
          else good.animate(
            [{ boxShadow: "0 0 0 0 rgba(26,127,55,.55)" }, { boxShadow: "0 0 0 14px rgba(26,127,55,0)" }],
            { duration: 450 });
        }
        if (!reduce && bad && bad.animate) {
          bad.animate(
            [{ transform: "translateX(0)" }, { transform: "translateX(-7px)" }, { transform: "translateX(6px)" },
            { transform: "translateX(-4px)" }, { transform: "translateX(0)" }],
            { duration: 320 });
        }
        if (window.FX) FX.sound(k === e.correct ? "good" : "bad");
      } catch (err) { }
    });
    $('opts').addEventListener('keydown', ev => {
      // Space activates the focused option (native button behavior). Enter is
      // reserved: during duels it opens the chat panel (see backend.js).
      if (ev.key !== ' ') return;
      const opt = ev.target.closest('.opt');
      if (opt) { ev.preventDefault(); opt.click(); }
    });
    $('markbtn').addEventListener('click', () => {
      const id = cur().id, at = S.marked.indexOf(id);
      if (at >= 0) S.marked.splice(at, 1); else S.marked.push(id);
      save(); renderQ();
    });
    $('right').addEventListener('click', ev => {
      if (ev.target.id === 'expbtn') {
        const open = $('exptext').classList.toggle('show');
        ev.target.textContent = open ? 'Hide' : 'Why?';
      }
    });

    /* ── Navigator (filtered questions) ── */
    function renderNavStats(right, wrong) {
      const el = $('navstats');
      if (!el) return;
      el.innerHTML = `
        <span class="navstat-pill right">✓ ${right} correct</span>
        <span class="navstat-pill wrong">✕ ${wrong} wrong</span>
      `;
    }
    function openNav() {
      // Duel review: jump between played questions (read-only past, live answerable).
      if (window.Net && Net.inChallenge && Net.inChallenge() && Net.duelRange) {
        const isRush = Net.inRush && Net.inRush();
        const r = Net.duelRange();
        if (r) {
          let html = '';
          let nRight = 0, nWrong = 0, nAnswered = 0;
          const maxP = isRush ? r.idxs.length - 1 : r.cur;
          for (let p = 0; p <= maxP; p++) {
            const i = r.idxs[p], e = DB[i], id = e.id, c = [];
            if (i === idx) c.push('cur');
            const a = isRush ? (Net.rushLocalAnswers && Net.rushLocalAnswers[id]) : S.answers[id];
            if (a) {
              nAnswered++;
              if (isRush) {
                c.push('answered');
              } else {
                const isR = a === e.correct;
                c.push(isR ? 'right' : 'wrong');
                if (isR) nRight++; else nWrong++;
              }
            }
            const bm = S.marked.includes(id) ? '<span class="bm">&#128278;</span>' : '';
            html += `<button class="${c.join(' ')}" data-i="${i}" style="animation-delay:${Math.min(p * 12, 240)}ms">${p + 1}${bm}</button>`;
          }
          const nc0 = $('navcount');
          if (nc0) nc0.textContent = (isRush ? nAnswered : (nRight + nWrong)) + " of " + (isRush ? r.idxs.length : (r.cur + 1)) + " answered";
          if (isRush) {
            const ns = $('navstats');
            if (ns) ns.innerHTML = `<span class="navstat-pill right" style="background:#0284c7;color:#fff">${nAnswered} answered</span> <span class="navstat-pill wrong">${r.idxs.length - nAnswered} remaining</span>`;
            const nre = $('nav-end-rush');
            if (nre) nre.style.display = "";
          } else {
            renderNavStats(nRight, nWrong);
            const nre = $('nav-end-rush');
            if (nre) nre.style.display = "none";
          }
          $('navgrid').innerHTML = html;
          $('ov-nav').classList.add('open');
          const curBtn = $('navgrid').querySelector('.cur');
          if (curBtn) curBtn.scrollIntoView({ block: 'center' });
          return;
        }
      }
      let html = '';
      let nRight = 0, nWrong = 0;
      for (let p = 0; p < F.length; p++) {
        const i = F[p], e = DB[i], id = e.id, c = [];
        if (i === idx) c.push('cur');
        const a = S.answers[id];
        if (a) {
          const isR = a === e.correct;
          c.push(isR ? 'right' : 'wrong');
          if (isR) nRight++; else nWrong++;
        }
        const bm = S.marked.includes(id) ? '<span class="bm">&#128278;</span>' : '';
        html += `<button class="${c.join(' ')}" data-i="${i}" style="animation-delay:${Math.min(p * 12, 240)}ms">${p + 1}${bm}</button>`;
      }
      const nAns = nRight + nWrong;
      const nc = $('navcount'); if (nc) nc.textContent = nAns + " of " + F.length + " answered";
      renderNavStats(nRight, nWrong);
      $('navgrid').innerHTML = html;
      $('ov-nav').classList.add('open');
      const curBtn = $('navgrid').querySelector('.cur');
      if (curBtn) curBtn.scrollIntoView({ block: 'center' });
    }
    $('navpill').addEventListener('click', openNav);
    $('navclose').addEventListener('click', () => $('ov-nav').classList.remove('open'));
    $('navgrid').addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      $('ov-nav').classList.remove('open');
      goTo(parseInt(b.dataset.i, 10));
    });

    /* ── Top bar tools ── */
    let cdHidden = false; // session-only: refresh always brings the countdown back
    function cdTarget() {
      const n = new Date();
      let t = new Date(n.getFullYear(), 10, 7);
      if (t <= n) t = new Date(n.getFullYear() + 1, 10, 7);
      return t;
    }
    function cdTick() {
      const ms = cdTarget() - new Date();
      if (ms <= 0) { $('cdtime').textContent = 'Today!'; return; }
      const d = Math.floor(ms / 864e5);
      $('cdtime').textContent = d + 'd';
      $('cdtime').title = 'November 7';
    }
    function cdApply() {
      $('cdtime').style.display = '';
    }
    setInterval(cdTick, 30000);
    const ZOOMS = [1, 1.25, 1.5];
    let zi = 0;
    $('zoomval').addEventListener('click', () => {
      zi = (zi + 1) % ZOOMS.length;
      document.documentElement.style.setProperty('--uiscale', ZOOMS[zi]);
      $('zoomval').textContent = Math.round(ZOOMS[zi] * 100) + '%';
    });

    /* ── Name box (bottom-left): input + Save. Identity = typed name only. ── */
    function syncName() {
      const n = (S.name || '').trim();
      const inp = $('nameinput'), who = $('whoami');
      if (n) {
        inp.style.display = 'none'; $('namesave').style.display = 'none';
        who.style.display = ''; who.textContent = n;
      } else {
        inp.style.display = ''; $('namesave').style.display = '';
        who.style.display = 'none'; inp.value = '';
      }
    }
    function commitName() {
      const v = ($('nameinput').value || '').trim().slice(0, 20);
      if (!v) { $('nameinput').focus(); return; }
      if (S.name && S.name !== v) {
        S.answers = {};
      }
      S.name = v; save(); syncName();
      const btn = $('namesave');
      btn.classList.remove('pop'); void btn.offsetWidth; btn.classList.add('pop');
      if (window.FX) FX.sound('pop');
      if (window.Net && Net.identify) Net.identify(v); // status/{name} + restore progress
      toast('Signed in as ' + v + ' 👋');
    }
    $('namesave').addEventListener('click', commitName);
    $('nameinput').addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); commitName(); }
      ev.stopPropagation();
    });
    // Double-click the saved name to change it.
    function editName() {
      $('nameinput').style.display = '';
      $('namesave').style.display = '';
      $('whoami').style.display = 'none';
      $('nameinput').value = S.name || '';
      $('nameinput').focus();
      $('nameinput').select();
    }
    $('whoami').addEventListener('dblclick', editName);
    $('whoami').style.cursor = 'pointer';
    $('whoami').title = 'Click to view profile · Double-click to change name';
    /* Tiny toast helper (used before backend.js loads too). */
    function toast(msg, ms) {
      const box = $('toasts'); if (!box) return;
      const el = document.createElement('div');
      el.className = 'toast'; el.textContent = msg;
      box.appendChild(el);
      requestAnimationFrame(() => el.classList.add('in'));
      setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, ms || 3200);
    }
    window.toast = toast;

    /* ── Bluebook-style highlights (saved per question in localStorage) ── */
    let hlPending = null;
    function hlSyncBtn() {
      $('hlbtn').classList.toggle('active', !!S.hlAuto);
      document.querySelectorAll('#hlpop [data-hlc]').forEach(b =>
        b.classList.toggle('on', b.dataset.hlc === S.hlColor));
    }
    $('hlbtn').addEventListener('click', () => {
      S.hlAuto = !S.hlAuto;
      save(); hlSyncBtn();
    });
    function selOffsets() {
      const sel = window.getSelection();
      if (!sel.rangeCount || sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      const txt = range.toString();
      if (!txt || !txt.trim()) return null;
      let box = null, w = null;
      if ($('passage').contains(range.commonAncestorContainer)) { box = $('passage'); w = 'p'; }
      else if ($('stem').contains(range.commonAncestorContainer)) { box = $('stem'); w = 's'; }
      else return null;
      const pre = range.cloneRange();
      pre.selectNodeContents(box);
      pre.setEnd(range.startContainer, range.startOffset);
      const s = pre.toString().length;
      const e = s + txt.length;
      if (e <= s) return null;
      // clamp to plain-text length of this side
      const plain = w === 'p' ? splitQA(stripU(cur().question)).passage : splitQA(stripU(cur().question)).stem;
      if (s >= plain.length) return null;
      return { w, s: Math.max(0, s), e: Math.min(plain.length, e), text: txt, rect: range.getBoundingClientRect() };
    }
    function hlHidePop() { $('hlpop').classList.remove('open'); hlPending = null; }
    function hlShowPop(x, y) {
      const pop = $('hlpop');
      pop.classList.add('open');
      const r = pop.getBoundingClientRect();
      pop.style.left = Math.min(window.innerWidth - 260, Math.max(8, x - 110)) + 'px';
      pop.style.top = Math.max(56, y - 52) + 'px';
    }
    function hlAdd(qid, w, s, e, c, u) {
      if (e <= s) return;
      const arr = S.hl[qid] || (S.hl[qid] = []);
      // drop overlaps on same side (new wins)
      S.hl[qid] = arr.filter(h => h.w !== w || h.e <= s || h.s >= e);
      S.hl[qid].push({ w, s, e, c: c || S.hlColor || 'y', u: u ? 1 : 0 });
      hlPopNew = S.hl[qid].length - 1;
      save(); renderQ(); hlSyncBtn();
      window.getSelection().removeAllRanges();
      hlHidePop();
    }
    function hlRemoveAt(qid, w, s, e) {
      if (!S.hl[qid]) return;
      S.hl[qid] = S.hl[qid].filter(h => h.w !== w || h.e <= s || h.s >= e);
      if (!S.hl[qid].length) delete S.hl[qid];
      save(); renderQ(); hlHidePop();
    }
    document.querySelectorAll('#hlpop [data-hlc]').forEach(b => b.addEventListener('click', ev => {
      ev.stopPropagation();
      S.hlColor = b.dataset.hlc;
      if (hlPending) hlAdd(cur().id, hlPending.w, hlPending.s, hlPending.e, S.hlColor, false);
      else { save(); hlSyncBtn(); }
    }));
    $('hl-del').addEventListener('click', ev => {
      ev.stopPropagation();
      if (!hlPending) { hlHidePop(); return; }
      hlRemoveAt(cur().id, hlPending.w, hlPending.s, hlPending.e);
    });
    function hlHandleSel(rect) {
      const o = selOffsets();
      if (!o) { hlHidePop(); return; }
      if (S.hlAuto) { hlAdd(cur().id, o.w, o.s, o.e, S.hlColor, false); return; }
      hlPending = o;
      hlSyncBtn();
      const x = rect ? rect.left + rect.width / 2 : (o.rect.left + o.rect.width / 2);
      const y = rect ? rect.top : o.rect.top;
      hlShowPop(x, y);
    }
    ['mouseup', 'touchend'].forEach(ev => document.addEventListener(ev, e => {
      if (e.target.closest && (e.target.closest('#hlpop') || e.target.closest('.modal') || e.target.closest('#moreMenu'))) return;
      if ($('exam').style.display === 'none') return;
      setTimeout(() => {
        const ae = document.activeElement;
        if (ae && (/INPUT|TEXTAREA/.test(ae.tagName) || ae.isContentEditable)) return;
        const sel = window.getSelection();
        if (!sel.rangeCount || sel.isCollapsed) {
          // click on existing highlight? offer delete/note
          const mk = e.target.closest ? e.target.closest('mark.hl') : null;
          if (mk && ($('passage').contains(mk) || $('stem').contains(mk))) {
            const qid = cur().id, qi = +mk.dataset.hl;
            const h = (S.hl[qid] || [])[qi];
            if (h) {
              hlPending = { w: h.w, s: h.s, e: h.e };
              hlSyncBtn();
              const r = mk.getBoundingClientRect();
              hlShowPop(r.left + r.width / 2, r.top);
              return;
            }
          }
          hlHidePop(); return;
        }
        hlHandleSel();
      }, S.hlAuto ? 120 : 60);
    }));
    document.addEventListener('scroll', () => hlHidePop(), true);
    $('left').addEventListener('scroll', () => { if ($('hlpop').classList.contains('open')) hlHidePop(); });
    $('right').addEventListener('scroll', () => { if ($('hlpop').classList.contains('open')) hlHidePop(); });
    $('morebtn').addEventListener('click', ev => { ev.stopPropagation(); $('moreMenu').classList.toggle('open'); });
    document.addEventListener('click', ev => {
      if (!ev.target.closest('#moreMenu')) $('moreMenu').classList.remove('open');
      if (ev.target.classList && ev.target.classList.contains('overlay')) ev.target.classList.remove('open');
    });
    $('mm-first').addEventListener('click', () => { $('moreMenu').classList.remove('open'); if (F.length) { idx = F[0]; renderQ(); } });
    $('mm-search').addEventListener('click', () => { $('moreMenu').classList.remove('open'); openSearch(); });
    $('mm-clear').addEventListener('click', () => {
      $('moreMenu').classList.remove('open');
      const qid = cur() && cur().id;
      if (!qid) return;
      // Net.clearAnswer deletes locally + from the remote database (ledger,
      // progress summary, today counter). Fallback covers pre-Net boot.
      if (window.Net && Net.clearAnswer) Net.clearAnswer(qid);
      else { delete S.answers[qid]; save(); renderQ(); }
    });

    /* ── Filters (saved in localStorage) ── */
    function filteredOn() { return S.fDom.length > 0 || S.fDif.length > 0; }
    function syncFCount() {
      const n = S.fDom.length + S.fDif.length;
      $('mm-fcount').textContent = n ? `(${n})` : '';
    }
    function syncFilterUI() {
      $('f-dom').innerHTML = DOMS.map(d =>
        `<label class="frow"><input type="checkbox" data-fd="${esc(d)}"${S.fDom.includes(d) ? ' checked' : ''}>${esc(d)}</label>`).join('');
      $('f-dif').innerHTML = DIFS.map(d =>
        `<label class="frow"><input type="checkbox" data-ff="${esc(d)}"${S.fDif.includes(d) ? ' checked' : ''}>${esc(d)}</label>`).join('');
      syncFCount();
    }
    function applyFilters() {
      rebuildF();
      syncFilterUI();
      save(); renderQ();
    }
    $('f-dom').addEventListener('change', ev => {
      const c = ev.target.closest('input[data-fd]'); if (!c) return;
      const d = c.dataset.fd;
      if (c.checked && !S.fDom.includes(d)) S.fDom.push(d);
      if (!c.checked) S.fDom = S.fDom.filter(x => x !== d);
      applyFilters();
    });
    $('f-dif').addEventListener('change', ev => {
      const c = ev.target.closest('input[data-ff]'); if (!c) return;
      const d = c.dataset.ff;
      if (c.checked && !S.fDif.includes(d)) S.fDif.push(d);
      if (!c.checked) S.fDif = S.fDif.filter(x => x !== d);
      applyFilters();
    });
    $('f-clear').addEventListener('click', () => { S.fDom = []; S.fDif = []; applyFilters(); });
    $('f-close').addEventListener('click', () => $('ov-filter').classList.remove('open'));
    $('mm-filter').addEventListener('click', () => { $('moreMenu').classList.remove('open'); syncFilterUI(); $('ov-filter').classList.add('open'); });
    // NOTE: mm-reset is wired in the prefs block above (clears UI prefs only;
    // Remote attempts are never deleted). No second handler here.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.overlay.open').forEach(o => o.classList.remove('open'));
        $('moreMenu').classList.remove('open');
        if (typeof hlHidePop === 'function') hlHidePop();
        return;
      }
      const ae = document.activeElement || {};
      const typing = /INPUT|TEXTAREA/.test(ae.tagName || '') || ae.isContentEditable;
      if (typing) return;
      if (e.key === 'ArrowRight') stepQ(1);
      else if (e.key === 'ArrowLeft') stepQ(-1);
      else if (e.key === '/') { e.preventDefault(); openSearch(); }
    });

    /* ── Search: match question ID, passage, stem, or choices (within filter) ── */
    function openSearch() {
      // Duel lock: both players stay on the same live question.
      if (window.Net && Net.inChallenge && Net.inChallenge()) { toast('Stay on this duel question ⚔️ — search unlocks after the match.'); return; }
      $('ov-search').classList.add('open');
      $('searchinput').value = '';
      $('searchresults').innerHTML = '';
      $('searchmeta').textContent = F.length + ' questions' + (filteredOn() ? ' (filtered)' : '') + ' — type at least 2 characters.';
      setTimeout(() => $('searchinput').focus(), 60);
    }
    let searchT = null;
    $('searchinput').addEventListener('input', () => {
      clearTimeout(searchT);
      searchT = setTimeout(runSearch, 180);
    });
    function snippetHTML(e, q) {
      if (e.id.includes(q)) return esc('ID match: ' + e.id);
      const hay = stripU(e.question) + ' ' + Object.values(e.choices).map(stripU).join(' ');
      const i = hay.toLowerCase().indexOf(q);
      const s = Math.max(0, i - 45);
      const raw = hay.slice(s, i + q.length + 45).replace(/\s+/g, ' ');
      const hi = raw.toLowerCase().indexOf(q);
      return (s > 0 ? '…' : '') + esc(raw.slice(0, hi)) + '<mark>' +
        esc(raw.slice(hi, hi + q.length)) + '</mark>' + esc(raw.slice(hi + q.length)) + '…';
    }
    function runSearch() {
      const q = $('searchinput').value.trim().toLowerCase();
      const box = $('searchresults');
      if (q.length < 2) {
        box.innerHTML = '';
        $('searchmeta').textContent = F.length + ' questions' + (filteredOn() ? ' (filtered)' : '') + ' — type at least 2 characters.';
        return;
      }
      let html = '', n = 0;
      for (let p = 0; p < F.length && n < 60; p++) {
        const i = F[p];
        const e = DB[i];
        if (!(e.id.includes(q) || stripU(e.question).toLowerCase().includes(q) ||
          Object.values(e.choices).some(c => stripU(c || '').toLowerCase().includes(q)))) continue;
        html += `<button class="sr-row" data-i="${i}"><span class="n">${p + 1}</span>` +
          `<span class="snip">${snippetHTML(e, q)}</span>` +
          `<span class="tag">${esc(e.skill || e.domain)}</span></button>`;
        n++;
      }
      $('searchmeta').textContent = n === 0 ? 'No matches.' :
        n + (n === 60 ? '+' : '') + ' match' + (n === 1 ? '' : 'es') + ' — click to jump.';
      box.innerHTML = html;
    }
    $('searchresults').addEventListener('click', ev => {
      const b = ev.target.closest('.sr-row'); if (!b) return;
      $('ov-search').classList.remove('open');
      goTo(parseInt(b.dataset.i, 10));
    });
    $('searchclose').addEventListener('click', () => $('ov-search').classList.remove('open'));

    /* ── Divider drag ── */
    (() => {
      const div = $('divider'); let on = false;
      div.addEventListener('mousedown', e => { on = true; e.preventDefault(); });
      document.addEventListener('mousemove', e => {
        if (!on) return;
        const r = $('panes').getBoundingClientRect();
        const pct = Math.min(75, Math.max(25, (e.clientX - r.left) / r.width * 100));
        $('left').style.flex = `1 1 ${pct}%`; $('right').style.flex = `1 1 ${100 - pct}%`;
      });
      document.addEventListener('mouseup', () => on = false);
    })();

    /* ── Fixed look & feel: white theme, sounds on, motion follows the OS. ──
       (No toggles. localStorage holds only the name + question prefs.) */
    function applyPrefs() {
      document.documentElement.dataset.theme = 'light';
      let motion = 'full';
      try {
        // Drop stale toggles from the older build so nothing stays muted/light.
        localStorage.removeItem('satbank:sound');
        localStorage.removeItem('satbank:theme');
        localStorage.removeItem('satbank:motion');
        if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) motion = 'reduced';
      } catch (e) { }
      document.documentElement.dataset.motion = motion;
    }
    function syncPrefUI() { } // kept: called by applyPrefs; nothing to sync (no controls).
    $('historybtn').addEventListener('click', () => { $('ov-history').classList.add('open'); if (window.Net) Net.renderHistory(); });
    // (No Close button: the popup closes via backdrop click or Esc — see global handlers.)
    $('challengebtn').addEventListener('click', () => {
      if (window.Net && Net.openChallenge) Net.openChallenge();
      else $('ov-challenge').classList.add('open');
    });
    $('challclose').addEventListener('click', () => $('ov-challenge').classList.remove('open'));
    $('mm-reset').addEventListener('click', async () => {
      // Wipes the WHOLE profile: name, every answer, history, presence.
      if (!confirm('Delete your ENTIRE profile? This erases your name, all answers, history and saved presence from the cloud. Cannot be undone.')) return;
      try {
        if (window.Net && Net.wipeMyData && Net.name) await Net.wipeMyData();
        localStorage.removeItem('satbank:name');
        localStorage.removeItem('satbank:ui');
        localStorage.removeItem('satbank:friend');
      } catch (e) { }
      location.reload();
    });

    /* ── Boot ── */
    function boot(data) {
      DB = data;
      load();
      applyPrefs();
      if (!S.hl || typeof S.hl !== 'object') S.hl = {};
      idx = Math.min(Math.max(S.currentIndex || 0, 0), DB.length - 1);
      rebuildF();
      $('loadwrap').style.display = 'none';
      $('exam').style.display = 'flex';
      renderQ();
      syncName();
      syncFilterUI();
      syncShuffleBtn();
      cdApply(); cdTick();
      hlSyncBtn();
      bootNet(0);
    }
    // The backend.js module is deferred and the CDN script can be slow, so the
    // question bank sometimes wins the race and window.Net doesn't exist yet when
    // boot() runs. Poll until the online layer is there (10s cap), then init once.
    function bootNet(tries) {
      if (window.Net && window.Net.init) {
        try { window.Net.init(DB); } // async: rejections handled inside; auto-identifies from saved name
        catch (e) { }
        return;
      }
      if ((tries || 0) < 100) setTimeout(() => bootNet((tries || 0) + 1), 100);
    }
    fetch('sat_db.json').then(r => { if (!r.ok) throw 0; return r.json(); })
      .then(boot).catch(() => { document.querySelector('#loadwrap .spinner').style.display = 'none'; $('loaderr').style.display = 'block'; });
    $('filepick').addEventListener('change', ev => {
      const f = ev.target.files[0]; if (!f) return;
      const rd = new FileReader(); rd.onload = () => boot(JSON.parse(rd.result)); rd.readAsText(f);
    });
    window.FX = (() => {
      const store = { on: true };
      try { store.on = localStorage.getItem('satbank:sound') !== 'off'; } catch (e) { }
      const reduceMotion = () =>
        (typeof matchMedia === 'function') && matchMedia('(prefers-reduced-motion: reduce)').matches;

      /* tiny WebAudio blips */
      let AC = null;
      function ac() {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        if (!AC) { try { AC = new Ctx(); } catch (e) { return null; } }
        if (AC.state === 'suspended') { try { AC.resume().catch(() => { }); } catch (e) { } }
        return AC;
      }
      function tone(f0, f1, delay, dur, type, vol) {
        const a = ac(); if (!a) return;
        try {
          const o = a.createOscillator(), g = a.createGain();
          o.type = type || 'sine';
          const t = a.currentTime + delay;
          o.frequency.setValueAtTime(f0, t);
          o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(vol || 0.11, t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g); g.connect(a.destination);
          o.start(t); o.stop(t + dur + 0.05);
        } catch (e) { }
      }
      const SFX = {
        good() { tone(660, 990, 0, 0.1); tone(1320, 1320, 0.02, 0.08, 'sine', 0.05); }, // soft ding + sparkle
        bad() { tone(220, 130, 0, 0.18, 'sawtooth', 0.07); },   // soft low thud, never harsh
        tick() { tone(1200, 1200, 0, 0.04, 'square', 0.03); },  // crisp button tick
        pop() { tone(500, 900, 0, 0.09); },                     // name-saved pop
        chime() { tone(784, 784, 0, 0.12); tone(1047, 1047, 0.1, 0.18); }, // friend online
        alert() { tone(659, 659, 0, 0.12); tone(880, 880, 0.13, 0.16); },  // challenge received
        count(i) { tone(440 + i * 160, 440 + i * 160, 0, 0.12); },         // countdown rising tones
        whoosh() { tone(300, 900, 0, 0.16, 'sine', 0.06); },    // card-flip reveal
        tada() { [523, 659, 784].forEach((f, i) => tone(f, f * 1.01, i * 0.08, 0.14)); }, // score up
        fanfare() {
          const a = ac(); if (!a) return;
          const now = a.currentTime;
          const notes = [
            { f: 349.23, time: 0.00, dur: 0.55, gain: 0.18 }, // F4
            { f: 440.00, time: 0.09, dur: 0.55, gain: 0.20 }, // A4
            { f: 523.25, time: 0.18, dur: 0.60, gain: 0.22 }, // C5
            { f: 659.25, time: 0.27, dur: 0.70, gain: 0.25 }, // E5
            { f: 783.99, time: 0.36, dur: 0.85, gain: 0.26 }, // G5
            { f: 1046.50, time: 0.46, dur: 1.60, gain: 0.30 } // C6 (Crown note)
          ];
          notes.forEach(n => {
            const start = now + n.time;
            const osc = a.createOscillator(), g = a.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(n.f, start);
            g.gain.setValueAtTime(0, start);
            g.gain.linearRampToValueAtTime(n.gain, start + 0.035);
            g.gain.exponentialRampToValueAtTime(0.0001, start + n.dur);
            osc.connect(g); g.connect(a.destination);
            osc.start(start); osc.stop(start + n.dur + 0.05);

            const harm = a.createOscillator(), harmG = a.createGain();
            harm.type = 'sine';
            harm.frequency.setValueAtTime(n.f * 2.01, start);
            harmG.gain.setValueAtTime(0, start);
            harmG.gain.linearRampToValueAtTime(n.gain * 0.35, start + 0.02);
            harmG.gain.exponentialRampToValueAtTime(0.0001, start + n.dur * 0.45);
            harm.connect(harmG); harmG.connect(a.destination);
            harm.start(start); harm.stop(start + n.dur * 0.5);
          });
          // Final chord shimmer
          [523.25, 783.99, 1046.50, 1318.51].forEach((freq, idx) => {
            const co = a.createOscillator(), cg = a.createGain();
            const cs = now + 0.46;
            co.type = 'sine';
            co.frequency.setValueAtTime(freq + (idx % 2 === 0 ? 0.75 : -0.75), cs);
            cg.gain.setValueAtTime(0, cs);
            cg.gain.linearRampToValueAtTime(0.12 / (idx + 1), cs + 0.08);
            cg.gain.exponentialRampToValueAtTime(0.0001, cs + 1.8);
            co.connect(cg); cg.connect(a.destination);
            co.start(cs); co.stop(cs + 1.85);
          });
        },
        neutral() {
          // Beloved soft defeat tone: E4 -> C4 -> A3
          const a = ac(); if (!a) return;
          const now = a.currentTime;
          [329.63, 261.63, 220.00].forEach((freq, i) => {
            const osc = a.createOscillator(), g = a.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + i * 0.18);
            g.gain.setValueAtTime(0, now + i * 0.18);
            g.gain.linearRampToValueAtTime(0.18, now + i * 0.18 + 0.05);
            g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.55);
            osc.connect(g); g.connect(a.destination);
            osc.start(now + i * 0.18);
            osc.stop(now + i * 0.18 + 0.6);
          });
        },
        tie() {
          const a = ac(); if (!a) return;
          const now = a.currentTime;
          [440, 554.37].forEach((freq, i) => {
            const osc = a.createOscillator(), g = a.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + i * 0.12);
            g.gain.setValueAtTime(0.15, now + i * 0.12);
            g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.5);
            osc.connect(g); g.connect(a.destination);
            osc.start(now + i * 0.12);
            osc.stop(now + i * 0.12 + 0.55);
          });
        },
        go() { tone(440, 880, 0, 0.12); },
        seal() { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, i * 0.09, 0.16)); },
        rank() {
          [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, f, i * 0.1, 0.22));
          tone(262, 262, 0, 0.7, 'triangle', 0.05);
        },
        nudge() { tone(880, 880, 0, 0.12); tone(1174, 1174, 0.14, 0.2); },
        msg() { tone(990, 990, 0, 0.07, 'sine', 0.05); tone(1320, 1320, 0.06, 0.09, 'sine', 0.04); }, // duel chat arrival: soft blip, no banner
      };
      function sound(name, arg) {
        if (!store.on) return;
        // All sounds <1.5s, low volume by default. Countdown takes an index.
        try { const f = SFX[name]; if (f) f(arg); } catch (e) { }
      }
      function toggle() {
        store.on = !store.on;
        try { localStorage.setItem('satbank:sound', store.on ? 'on' : 'off'); } catch (e) { }
        return store.on;
      }

      /* canvas confetti & celebration physics engine */
      const PALETTE = ['#2563eb', '#3b82f6', '#60a5fa', '#f59e0b', '#fbbf24', '#10b981', '#8b5cf6'];
      let cv = null, ctx = null, parts = [], rafId = 0, lastT = 0;
      function ensureCv() {
        if (cv) return true;
        try {
          cv = document.createElement('canvas');
          cv.id = 'fx-confetti';
          cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;' +
            'pointer-events:none;z-index:500;';
          document.body.appendChild(cv);
          ctx = cv.getContext('2d');
          const fit = () => { cv.width = innerWidth; cv.height = innerHeight; };
          fit();
          addEventListener('resize', fit);
          return true;
        } catch (e) { return false; }
      }

      /* Smooth sky falling celebratory particles */
      let skyParts = [], skyRafId = 0;
      class SkyParticle {
        constructor() {
          this.reset();
          this.y = -20 - Math.random() * (innerHeight * 0.6);
        }
        reset() {
          this.x = Math.random() * innerWidth;
          this.y = -20 - Math.random() * 80;
          this.size = 7 + Math.random() * 8;
          this.color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
          this.type = Math.random() > 0.35 ? 'ribbon' : 'star';
          this.vy = 2.2 + Math.random() * 2.8;
          this.vx = (Math.random() - 0.5) * 1.6;
          this.rotation = Math.random() * 360;
          this.vRot = (Math.random() - 0.5) * 4;
          this.wobble = Math.random() * Math.PI * 2;
          this.vWobble = 0.04 + Math.random() * 0.06;
          this.opacity = 0.95;
        }
        update() {
          this.wobble += this.vWobble;
          this.rotation += this.vRot;
          this.x += this.vx + Math.sin(this.wobble) * 1.1;
          this.y += this.vy;
          if (this.y > innerHeight - 100) this.opacity -= 0.02;
          return this.y <= innerHeight + 30 && this.opacity > 0;
        }
        draw(c) {
          c.save();
          c.translate(this.x, this.y);
          c.rotate((this.rotation * Math.PI) / 180);
          c.scale(Math.cos(this.wobble), 1);
          c.globalAlpha = Math.max(0, this.opacity);
          c.fillStyle = this.color;
          if (this.type === 'ribbon') {
            const w = this.size, h = this.size * 0.55;
            c.beginPath();
            if (c.roundRect) c.roundRect(-w / 2, -h / 2, w, h, 2);
            else c.rect(-w / 2, -h / 2, w, h);
            c.fill();
          } else {
            const r = this.size * 0.7;
            c.beginPath();
            for (let i = 0; i < 8; i++) {
              const rad = (i * Math.PI) / 4;
              const dist = i % 2 === 0 ? r : r * 0.35;
              const px = Math.cos(rad) * dist, py = Math.sin(rad) * dist;
              if (i === 0) c.moveTo(px, py);
              else c.lineTo(px, py);
            }
            c.closePath();
            c.fill();
          }
          c.restore();
        }
      }

      function celebrate() {
        if (!ensureCv() || reduceMotion()) return;
        skyParts = [];
        for (let i = 0; i < 75; i++) {
          skyParts.push(new SkyParticle());
        }
        if (skyRafId) cancelAnimationFrame(skyRafId);
        function loop() {
          if (!ctx) return;
          ctx.clearRect(0, 0, cv.width, cv.height);
          skyParts = skyParts.filter(p => {
            const alive = p.update();
            if (alive) p.draw(ctx);
            return alive;
          });
          if (skyParts.length > 0) {
            skyRafId = requestAnimationFrame(loop);
          } else {
            ctx.clearRect(0, 0, cv.width, cv.height);
            skyRafId = 0;
          }
        }
        loop();
      }

      function stopCelebration() {
        if (skyRafId) { cancelAnimationFrame(skyRafId); skyRafId = 0; }
        skyParts = [];
        if (ctx && cv) ctx.clearRect(0, 0, cv.width, cv.height);
      }

      function spawn(n, colors, spread) {
        if (!ensureCv()) return;
        const C = (colors && colors.length) ? colors : PALETTE;
        for (let i = 0; i < n; i++) {
          parts.push({
            x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * (spread || 0.4),
            y: innerHeight * 0.32,
            vx: (Math.random() - 0.5) * 9, vy: -Math.random() * 9 - 3,
            s: Math.random() * 7 + 4, r: Math.random() * Math.PI,
            vr: (Math.random() - 0.5) * 0.3,
            c: C[(Math.random() * C.length) | 0],
            life: 1, decay: 0.004 + Math.random() * 0.006,
            shape: (Math.random() * 3) | 0,
          });
        }
        if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(tick); }
      }
      function tick(t) {
        const dt = Math.min(50, t - lastT); lastT = t;
        const k = dt / 16.6;
        ctx.clearRect(0, 0, cv.width, cv.height);
        parts = parts.filter(p => p.life > 0 && p.y < innerHeight + 30);
        for (const p of parts) {
          p.vy += 0.22 * k; p.x += p.vx * k; p.y += p.vy * k;
          p.r += p.vr * k; p.life -= p.decay * k;
          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
          ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
          if (p.shape === 0) ctx.fillRect(-p.s / 2, -p.s / 3, p.s, p.s * 0.66);
          else if (p.shape === 1) { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, 7); ctx.fill(); }
          else {
            ctx.beginPath(); ctx.moveTo(0, -p.s / 2);
            ctx.lineTo(p.s / 2, p.s / 2); ctx.lineTo(-p.s / 2, p.s / 2);
            ctx.closePath(); ctx.fill();
          }
          ctx.restore();
        }
        rafId = parts.length ? requestAnimationFrame(tick) : 0;
      }
      function burst(kind, colors) {
        try {
          if (reduceMotion()) return;
          if (kind === 'perfect') {
            spawn(150, colors); setTimeout(() => spawn(110, colors), 350);
            setTimeout(() => spawn(90, colors), 700);
          } else if (kind === 'mini') spawn(36, colors, 0.25);
          else spawn(110, colors);
        } catch (e) { }
      }

      /* rank-up overlay (markup + CSS injected once) */
      function ensureRankup() {
        let ov = document.getElementById('ov-rankup');
        if (ov) return ov;
        ov = document.createElement('div');
        ov.className = 'overlay';
        ov.id = 'ov-rankup';
        ov.innerHTML = '<div class="modal rankup-modal">' +
          '<div id="rankup-badge"></div><h2 id="rankup-name">RANK UP</h2>' +
          '<div id="rankup-sub" class="duo-sub"></div>' +
          '<div class="mrow" style="justify-content:center">' +
          '<button class="btn-blue" id="rankup-close">Keep climbing</button></div></div>';
        document.body.appendChild(ov);
        const st = document.createElement('style');
        st.id = 'fx-rankup-css';
        st.textContent =
          '.rankup-modal{text-align:center;max-width:420px}' +
          '#rankup-badge svg{filter:drop-shadow(0 6px 18px rgba(0,0,0,.35));' +
          'animation:rankpop .55s cubic-bezier(.2,1.6,.4,1)}' +
          '@keyframes rankpop{0%{transform:scale(.25) rotate(-14deg);opacity:0}' +
          '60%{transform:scale(1.12) rotate(2deg);opacity:1}100%{transform:scale(1)}}' +
          '#rankup-name{letter-spacing:.12em;margin:10px 0 4px}' +
          '#rankup-sub{font-size:15px;margin-bottom:6px}';
        document.head.appendChild(st);
        ov.querySelector('#rankup-close').addEventListener('click', () => {
          ov.classList.remove('open');
        });
        return ov;
      }
      function rankUp(rank, tier, sub, badgeHTML, colors) {
        try {
          const ov = ensureRankup();
          document.getElementById('rankup-badge').innerHTML = badgeHTML || '';
          document.getElementById('rankup-name').textContent =
            'RANK UP — ' + String(rank || '').toUpperCase() + (tier ? ' ' + tier : '');
          document.getElementById('rankup-sub').textContent = sub || '';
          ov.classList.add('open');
          sound('rank');
          burst('perfect', colors);
        } catch (e) { }
      }

      /* sounds are always on now (no toggle); store only keeps the default. */

      return {
        sound, toggle,
        get soundOn() { return store.on; },
        setOn(v) { store.on = !!v; try { localStorage.setItem('satbank:sound', store.on ? 'on' : 'off'); } catch (e) { } },
        confetti(n, colors) { try { if (!reduceMotion()) spawn(n || 80, colors); } catch (e) { } },
        celebrate, stopCelebration,
        burst, rankUp,
      };
    })();
}
