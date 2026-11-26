// Tiny DOM helpers: element builder, icons, modal, toast and form fields.
// Everything from the db goes in as text nodes, never as HTML.

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'multiple', 'readOnly', 'required']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (val == null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (PROPS.has(k)) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
};

// Simple line icons (24x24, stroke = currentColor).
const ICONS = {
  today: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  week: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8.5 9.5V20M15.5 9.5V20"/>',
  month: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/><circle cx="8" cy="13.5" r=".9" fill="currentColor"/><circle cx="12" cy="13.5" r=".9" fill="currentColor"/><circle cx="16" cy="13.5" r=".9" fill="currentColor"/><circle cx="8" cy="17" r=".9" fill="currentColor"/><circle cx="12" cy="17" r=".9" fill="currentColor"/>',
  kids: '<circle cx="8.5" cy="8" r="3"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M3 19.5c.6-3.4 2.8-5.2 5.5-5.2s4.9 1.8 5.5 5.2M13.6 15.2c.8-.6 1.8-.9 2.9-.9 2.2 0 3.9 1.5 4.4 4.2"/>',
  manage: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  car: '<path d="M5 16.5h14M6.2 16.5 5 12.6l1.6-4.1A2 2 0 0 1 8.5 7.2h7a2 2 0 0 1 1.9 1.3l1.6 4.1-1.2 3.9"/><circle cx="8" cy="16.5" r="1.6"/><circle cx="16" cy="16.5" r="1.6"/><path d="M5 12.6h14"/>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  left: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  right: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="6" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="18" cy="12" r="1.3" fill="currentColor"/>',
  edit: '<path d="m4.5 19.5 1-4.2L15.8 5a1.8 1.8 0 0 1 2.5 0l.7.7a1.8 1.8 0 0 1 0 2.5L8.7 18.5z"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17h.01"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  cloud: '<path d="M7 18.5h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.6A3.3 3.3 0 0 0 7 18.5z"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/>',
  rewards: '<path d="M12 3.8 14.17 9.41 20.18 9.74 15.52 13.54 17.05 19.36 12 16.1 6.95 19.36 8.48 13.54 3.82 9.74 9.83 9.41Z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.8a4 4 0 0 1 7.6-1.7"/>',
  download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
  minus: '<path d="M5 12h14"/>',
};

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// ---- modal -----------------------------------------------------------------

const modalStack = [];

export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  const root = document.getElementById('modal-root');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    modalStack.splice(modalStack.indexOf(close), 1);
    document.body.classList.toggle('modal-open', modalStack.length > 0);
    onClose?.();
  };
  const footer = actions.length
    ? h('footer', { class: 'modal-actions' }, actions.map((a) => h('button', {
      type: a.submit ? 'submit' : 'button',
      class: `btn ${a.primary ? 'btn-primary' : ''} ${a.danger ? 'btn-danger' : ''} ${a.ghost ? 'btn-ghost' : ''}`,
      onclick: a.submit ? null : async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          const keepOpen = await a.onClick?.(close);
          if (!keepOpen) close();
        } finally {
          btn.disabled = false;
        }
      },
    }, a.label)))
    : null;
  const dialog = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body),
    footer);
  const backdrop = h('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) close(); } }, dialog);
  root.append(backdrop);
  modalStack.push(close);
  document.body.classList.add('modal-open');
  setTimeout(() => dialog.querySelector('input:not([type=hidden]),select,textarea')?.focus({ preventScroll: true }), 50);
  return close;
}

export function closeTopModal() {
  modalStack.at(-1)?.();
}

export function confirmDialog(title, message, { confirmLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      body: h('p', null, message),
      onClose: () => { if (!answered) resolve(false); },
      actions: [
        { label: 'Cancel', ghost: true, onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { answered = true; resolve(true); } },
      ],
    });
  });
}

// ---- toast -------------------------------------------------------------------

export function toast(message, { kind = 'info', ms = 3500, action } = {}) {
  const root = document.getElementById('toast-root');
  const el = h('div', { class: `toast toast-${kind}`, role: 'status' }, h('span', null, message),
    action ? h('button', { class: 'btn btn-small', onclick: () => { action.onClick(); el.remove(); } }, action.label) : null);
  root.append(el);
  setTimeout(() => el.classList.add('toast-out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

// ---- form fields -----------------------------------------------------------------

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('small', { class: 'field-hint' }, hint) : null);
}

export function input(props = {}) {
  return h('input', { type: 'text', ...props });
}

export function select(options, value, props = {}) {
  return h('select', props, options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
}

export function textarea(value = '', props = {}) {
  const t = h('textarea', props);
  t.value = value;
  return t;
}

export function checkbox(label, checked, props = {}) {
  const box = h('input', { type: 'checkbox', checked: !!checked, ...props });
  return { el: h('label', { class: 'check' }, box, h('span', null, label)), box };
}

export function chips(options, selected, { multi = true } = {}) {
  const chosen = new Set(selected || []);
  const wrap = h('div', { class: 'chip-row', role: multi ? 'group' : 'radiogroup' });
  const render = () => {
    clear(wrap);
    for (const o of options) {
      const on = chosen.has(o.value);
      wrap.append(h('button', {
        type: 'button',
        class: `chip ${on ? 'chip-on' : ''}`,
        'aria-pressed': on ? 'true' : 'false',
        style: o.color && on ? { background: o.color, borderColor: o.color, color: '#fff' } : null,
        onclick: () => {
          if (multi) {
            if (chosen.has(o.value)) chosen.delete(o.value);
            else chosen.add(o.value);
          } else {
            chosen.clear();
            chosen.add(o.value);
          }
          render();
        },
      }, o.label));
    }
  };
  render();
  return { el: wrap, get: () => options.map((o) => o.value).filter((v) => chosen.has(v)) };
}

export function formError(el, errors) {
  clear(el);
  if (!errors || !errors.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  append(el, [h('strong', null, 'Please fix:'), h('ul', null, errors.map((e) => h('li', null, e)))]);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const t = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    t.value = text;
    document.body.append(t);
    t.select();
    const ok = document.execCommand('copy');
    t.remove();
    return ok;
  }
}

export function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
