// A drop-down that stands in for a native <select>: grouped, searchable when the list is long, and dressed
// like the rest of the game. The <select> stays in the page (hidden) as the value the game reads and writes,
// and still fires `change`; this only replaces what you see and click.

const picks = [];
let openPick = null;
const SEARCH_FROM = 16;        // lists at least this long get a search box
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class Pick {
  constructor(sel, o) {
    this.sel = sel; this.o = o; this.pop = null; this.act = -1;
    const b = this.btn = document.createElement('button');
    b.type = 'button'; b.className = 'pick'; b.setAttribute('aria-haspopup', 'listbox'); b.setAttribute('aria-expanded', 'false');
    b.innerHTML = '<span class="pick-v"></span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>';
    this.label = b.firstChild;
    sel.hidden = true; sel.before(b);                  // before the select, so a click on the <label> lands on the button
    b.addEventListener('click', () => (openPick === this ? this.close(true) : this.open()));
    b.addEventListener('keydown', (e) => {
      if (this.pop) { e.stopPropagation(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); this.open(); }
    });
    sel.addEventListener('change', () => this.sync());
    this.sync();
  }

  /** Show the select's current choice on the button. */
  sync() { const op = this.sel.selectedOptions[0]; this.label.textContent = op ? op.textContent : ''; }

  open() {
    openPick?.close();
    const sel = this.sel, search = sel.options.length >= SEARCH_FROM;
    const item = (op) => {
      const sub = this.o.describe?.(op.value);
      return `<div class="pick-opt${op.selected ? ' sel' : ''}" role="option" aria-selected="${op.selected}" data-v="${esc(op.value)}"><span class="pick-n">${esc(op.textContent)}</span>` +
        `${this.o.code ? `<span class="pick-c">${esc(op.value)}</span>` : ''}${sub ? `<span class="pick-s">${esc(sub)}</span>` : ''}</div>`;
    };
    let html = '';
    for (const ch of sel.children) html += ch.tagName === 'OPTGROUP' ? `<div class="pick-g">${esc(ch.label)}</div>` + [...ch.children].map(item).join('') : item(ch);
    const pop = this.pop = document.createElement('div');
    pop.className = 'pick-pop';
    pop.innerHTML = (search ? `<input class="pick-q" type="search" placeholder="${esc(this.o.placeholder || 'Search')}" aria-label="${esc(this.o.placeholder || 'Search')}" autocomplete="off" spellcheck="false" />` : '') +
      `<div class="pick-list" role="listbox" tabindex="-1">${html}<div class="pick-none" hidden>Nothing matches.</div></div>`;
    document.body.appendChild(pop);
    this.list = pop.querySelector('.pick-list'); this.q = pop.querySelector('.pick-q'); this.typed = ''; this.typedAt = 0;
    this.rows = [...this.list.querySelectorAll('.pick-opt')];
    this.place();
    this.setActive(this.rows.findIndex((r) => r.classList.contains('sel')), true);

    pop.addEventListener('click', (e) => { const r = e.target.closest('.pick-opt'); if (r) this.choose(r.dataset.v); });
    pop.addEventListener('pointermove', (e) => { const r = e.target.closest('.pick-opt'); if (r) this.setActive(this.rows.indexOf(r)); });
    pop.addEventListener('keydown', (e) => this.key(e));
    this.q?.addEventListener('input', () => this.filter(this.q.value));
    this.outside = (e) => { if (!pop.contains(e.target) && !this.btn.contains(e.target) && !this.btn.parentElement.contains(e.target)) this.close(); };
    this.away = () => this.close();
    addEventListener('pointerdown', this.outside, true); addEventListener('resize', this.away); addEventListener('blur', this.away);
    this.btn.setAttribute('aria-expanded', 'true');
    openPick = this;
    (this.q || this.list).focus({ preventScroll: true });
  }

  /** Put the list under the button, or above it when there is more room there (the title screen's sit at the bottom). */
  place() {
    // Sideways it lines up with the button; up and down it clears the whole labelled field the button sits in.
    const r = this.btn.getBoundingClientRect(), f = (this.btn.closest('label') || this.btn).getBoundingClientRect();
    const s = this.pop.style, vh = innerHeight, vw = innerWidth, gap = 6, edge = 8;
    const below = vh - f.bottom - gap - edge, above = f.top - gap - edge;
    const up = below < Math.min(this.pop.scrollHeight, vh * 0.5) && above > below;
    this.pop.classList.toggle('up', up);
    s.minWidth = `${Math.round(r.width)}px`;
    s.maxHeight = `${Math.round(Math.max(140, Math.min(up ? above : below, vh * 0.66)))}px`;
    s.left = `${Math.round(Math.max(edge, Math.min(r.left, vw - this.pop.offsetWidth - edge)))}px`;
    if (up) { s.top = 'auto'; s.bottom = `${Math.round(vh - f.top + gap)}px`; } else { s.bottom = 'auto'; s.top = `${Math.round(f.bottom + gap)}px`; }
  }

  visible() { return this.rows.filter((r) => !r.hidden); }

  setActive(i, centre) {
    const row = this.rows[i];
    if (!row || row.hidden) return;
    this.rows[this.act]?.classList.remove('act');
    this.act = i; row.classList.add('act');
    // Keep it in view by moving the list alone (scrollIntoView would also try to scroll the page).
    const l = this.list, top = row.offsetTop - l.offsetTop, bottom = top + row.offsetHeight, head = 30;
    if (centre) l.scrollTop = top - (l.clientHeight - row.offsetHeight) / 2;
    else if (top < l.scrollTop + head) l.scrollTop = top - head;
    else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
  }

  /** Show the rows whose name, code or group holds every word typed. */
  filter(text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    let group = null, groupName = '', any = false, anyAtAll = false;
    for (const el of this.list.children) {
      if (el.classList.contains('pick-g')) { if (group) group.hidden = !any; group = el; groupName = el.textContent.toLowerCase(); any = false; continue; }
      if (!el.classList.contains('pick-opt')) continue;
      const hay = `${el.textContent} ${el.dataset.v} ${groupName}`.toLowerCase();
      el.hidden = !words.every((w) => hay.includes(w));
      if (!el.hidden) { any = true; anyAtAll = true; }
    }
    if (group) group.hidden = !any;
    this.list.querySelector('.pick-none').hidden = anyAtAll;
    this.rows[this.act]?.classList.remove('act'); this.act = -1;
    const first = this.rows.findIndex((r) => !r.hidden);
    if (first >= 0) this.setActive(first);
    this.list.scrollTop = 0;
  }

  key(e) {
    e.stopPropagation();                               // the game's own keys (Esc, P, H ...) must not fire through an open list
    const vis = this.visible(), at = vis.indexOf(this.rows[this.act]), page = Math.max(1, Math.floor(this.list.clientHeight / 34) - 1);
    const go = (n) => { e.preventDefault(); if (vis.length) this.setActive(this.rows.indexOf(vis[Math.max(0, Math.min(vis.length - 1, n))])); };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? vis.length - 1 : at - 1);
    else if (e.key === 'PageDown') go(at + page);
    else if (e.key === 'PageUp') go(at - page);
    else if (e.key === 'Home' && !this.q) go(0);
    else if (e.key === 'End' && !this.q) go(vis.length - 1);
    else if (e.key === 'Enter' || (e.key === ' ' && !this.q)) { e.preventDefault(); if (this.rows[this.act] && !this.rows[this.act].hidden) this.choose(this.rows[this.act].dataset.v); }
    else if (e.key === 'Escape') { e.preventDefault(); this.close(true); }
    else if (e.key === 'Tab') this.close(true);
    else if (!this.q && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // No search box on a short list: typing jumps to the next entry that starts with what was typed.
      const now = performance.now();
      this.typed = now - this.typedAt < 700 ? this.typed + e.key.toLowerCase() : e.key.toLowerCase(); this.typedAt = now;
      const from = this.typed.length > 1 ? Math.max(0, at) : at + 1;
      const hit = [...vis.slice(from), ...vis.slice(0, from)].find((r) => r.firstChild.textContent.toLowerCase().startsWith(this.typed));
      if (hit) this.setActive(this.rows.indexOf(hit));
    }
  }

  choose(v) {
    const changed = this.sel.value !== v;
    this.sel.value = v; this.sync(); this.close(true);
    if (changed) this.sel.dispatchEvent(new Event('change', { bubbles: true }));
  }

  close(refocus) {
    if (!this.pop) return;
    removeEventListener('pointerdown', this.outside, true); removeEventListener('resize', this.away); removeEventListener('blur', this.away);
    this.pop.remove(); this.pop = null; this.act = -1;
    this.btn.setAttribute('aria-expanded', 'false');
    if (openPick === this) openPick = null;
    if (refocus) this.btn.focus({ preventScroll: true });
  }
}

/**
 * Replace a <select> on screen. opts: { code: show each option's value beside its name (airfield codes),
 * describe(value): a line of description under the name, placeholder: text for the search box }.
 */
export function enhanceSelect(sel, opts = {}) { const p = new Pick(sel, opts); picks.push(p); return p; }
/** Re-read every select (call after filling or setting them from code) and shut any open list. */
export function syncPickers() { openPick?.close(); for (const p of picks) p.sync(); }
