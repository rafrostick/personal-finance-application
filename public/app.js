'use strict';

const BACKEND = 'https://localhost:3001';

// ── Constants (immutable, no injection surface) ───────────────────────────
const VALID_PAGES = Object.freeze(['dashboard','transactions','budget','goals','accounts']);
const VALID_TYPES = Object.freeze(['income','expense']);
const VALID_FILTERS = Object.freeze(['all','income','expense']);
const VALID_ACCOUNT_TYPES = Object.freeze(['Bank','Credit','Investment','Other']);

const INCOME_CATS = Object.freeze(['Salary','Freelance','Investment','Side hustle','Other income']);
const EXPENSE_CATS = Object.freeze(['Housing','Food','Transport','Healthcare','Entertainment','Shopping','Utilities','Insurance','Education','Other expense']);
const ALL_CATS = Object.freeze([...INCOME_CATS, ...EXPENSE_CATS]);

const CAT_COLORS = Object.freeze({
  Housing:'#5b4de8',Food:'#f59e0b',Transport:'#10b981',Healthcare:'#ef4444',
  Entertainment:'#8b5cf6',Shopping:'#ec4899',Utilities:'#06b6d4',Insurance:'#64748b',
  Education:'#f97316','Other expense':'#94a3b8',Salary:'#22c55e',Freelance:'#3b82f6',
  Investment:'#a855f7','Side hustle':'#f43f5e','Other income':'#6ee7b7',
});

const GOAL_ICONS = Object.freeze(['ti-target','ti-plane','ti-car','ti-home','ti-school','ti-heart','ti-briefcase','ti-shield-check']);
const GOAL_COLORS = Object.freeze(['#5b4de8','#10b981','#f59e0b','#ef4444','#3b82f6','#ec4899','#8b5cf6','#06b6d4']);

const MAX_DESC_LEN = 100;
const MAX_NAME_LEN = 80;
const MAX_AMOUNT = 999_999_999;
const MAX_TRANSACTIONS = 5000;
const MAX_GOALS = 50;
const MAX_ACCOUNTS = 100;

// ── Sanitization ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function sanitizeText(val, maxLen = MAX_DESC_LEN) {
  if (typeof val !== 'string') return '';
  return val.replace(/[\x00-\x1F\x7F]/g,'').trim().slice(0, maxLen);
}

function sanitizeAmount(val) {
  const n = parseFloat(val);
  if (!isFinite(n) || n < 0 || n > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

function sanitizeDate(val) {
  if (typeof val !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return null;
  const d = new Date(val);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  if (y < 2000 || y > 2100) return null;
  return val;
}

function sanitizeEnum(val, allowed) {
  return allowed.includes(val) ? val : null;
}

function sanitizeBalance(val) {
  const n = parseFloat(val);
  if (!isFinite(n) || Math.abs(n) > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

function sanitizePct(n) {
  return Math.min(100, Math.max(0, Math.round(n)));
}

// ── Schema validators — applied to every object before storing ────────────
function validateTransaction(raw) {
  const desc = sanitizeText(raw.desc, MAX_DESC_LEN);
  const amount = sanitizeAmount(raw.amount);
  const date = sanitizeDate(raw.date);
  const type = sanitizeEnum(raw.type, VALID_TYPES);
  const cat = sanitizeEnum(raw.cat, ALL_CATS);
  const account = sanitizeText(raw.account, MAX_NAME_LEN);
  if (!desc || amount === null || !date || !type || !cat || !account) return null;
  return {
    id: sanitizeText(raw.id || ('t' + Date.now()), 200),
    desc, amount, date, type, cat,
    account: account || 'Other',
    plaid: raw.plaid === true,
  };
}

function validateGoal(raw) {
  const name = sanitizeText(raw.name, MAX_NAME_LEN);
  const target = sanitizeAmount(raw.target);
  const saved = sanitizeAmount(raw.saved ?? 0);
  const deadline = sanitizeDate(raw.deadline);
  const icon = GOAL_ICONS.includes(raw.icon) ? raw.icon : GOAL_ICONS[0];
  const color = GOAL_COLORS.includes(raw.color) ? raw.color : GOAL_COLORS[0];
  if (!name || target === null || saved === null || !deadline) return null;
  return {
    id: sanitizeText(raw.id || ('g' + Date.now()), 200),
    name, target, saved: Math.min(saved, target), deadline, icon, color,
  };
}

function validateAccount(raw) {
  const name = sanitizeText(raw.name, MAX_NAME_LEN);
  const type = sanitizeEnum(raw.type, VALID_ACCOUNT_TYPES) || 'Bank';
  const balance = sanitizeBalance(raw.balance);
  if (!name || balance === null) return null;
  return {
    id: sanitizeText(raw.id || ('a' + Date.now()), 200),
    name, type, balance,
    plaid: raw.plaid === true,
  };
}

function validateBudget(raw) {
  if (typeof raw !== 'object' || raw === null) return {};
  const out = {};
  for (const [cat, val] of Object.entries(raw)) {
    if (!EXPENSE_CATS.includes(cat)) continue;
    const n = sanitizeAmount(val);
    if (n !== null && n > 0) out[cat] = n;
  }
  return out;
}

// ── State ────────────────────────────────────────────────────────────────
let state = {
  page: 'dashboard',
  transactions: [],
  goals: [],
  accounts: [],
  budget: {},
  plaidLinked: [],
  syncing: false,
  backendOnline: false,
  txFilter: 'all',
  modals: {},
};

// ── Persistence ────────────────────────────────────────────────────────────
async function loadState() {
  try {
    const r = await window.storage.get('gt-v3');
    if (r && r.value) {
      const raw = JSON.parse(r.value);
      // Validate every persisted record through the schema — never trust stored data blindly
      state.transactions = (Array.isArray(raw.transactions) ? raw.transactions : [])
        .map(validateTransaction).filter(Boolean).slice(0, MAX_TRANSACTIONS);
      state.goals = (Array.isArray(raw.goals) ? raw.goals : [])
        .map(validateGoal).filter(Boolean).slice(0, MAX_GOALS);
      state.accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
        .map(validateAccount).filter(Boolean).slice(0, MAX_ACCOUNTS);
      state.budget = validateBudget(raw.budget);
      state.plaidLinked = (Array.isArray(raw.plaidLinked) ? raw.plaidLinked : [])
        .filter(p => p && typeof p.item_id === 'string' && typeof p.name === 'string')
        .map(p => ({ item_id: sanitizeText(p.item_id, 200), name: sanitizeText(p.name) }));
    }
  } catch(e) { console.warn('State load failed, starting fresh:', e); }
  await checkBackend();
  render();
}

async function saveState() {
  try {
    await window.storage.set('gt-v3', JSON.stringify({
      transactions: state.transactions,
      goals: state.goals,
      accounts: state.accounts,
      budget: state.budget,
      plaidLinked: state.plaidLinked,
    }));
  } catch(e) { console.error('Save failed:', e); }
}

// ── Toast notifications (replaces alert()) ────────────────────────────────
function toast(msg, duration = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = sanitizeText(msg, 200);
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}


// ── Backend / Plaid ────────────────────────────────────────────────────────
async function checkBackend() {
  try {
    const r = await fetch(`${BACKEND}/api/linked_accounts`, {signal:AbortSignal.timeout(2000)});
    state.backendOnline = r.ok;
    if (r.ok) {
      // Restore linked bank list from server so page refreshes don't forget connected banks
      const itemsRes = await fetch(`${BACKEND}/api/linked_items`, {signal:AbortSignal.timeout(2000)});
      if (itemsRes.ok) {
        const { items } = await itemsRes.json();
        if (Array.isArray(items)) {
          items.forEach(item => {
            if (!state.plaidLinked.find(p => p.item_id === item.item_id)) {
              state.plaidLinked.push({
                item_id: sanitizeText(item.item_id, 200),
                name: sanitizeText(item.name),
              });
            }
          });
        }
      }
    }
  } catch(e) { state.backendOnline = false; }
}

async function launchPlaidLink() {
  if (!state.backendOnline) {
    toast('Backend server is not running. Start server.js first.');
    return;
  }
  if (typeof window.Plaid === 'undefined') {
    toast('Plaid script not loaded. Check your connection.');
    return;
  }
  try {
    const ltRes = await fetch(`${BACKEND}/api/create_link_token`, {method:'POST'});
    if (!ltRes.ok) throw new Error('Failed to create link token');
    const {link_token, error} = await ltRes.json();
    if (error) throw new Error(typeof error === 'string' ? error : 'Link token error');
    if (!link_token || typeof link_token !== 'string') throw new Error('Invalid link token received');

    window.Plaid.create({
      token: link_token,
      onSuccess: async (public_token, metadata) => {
        const institution = sanitizeText(metadata?.institution?.name || 'My Bank');
        try {
          const exRes = await fetch(`${BACKEND}/api/exchange_token`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({public_token, institution_name: institution}),
          });
          if (!exRes.ok) throw new Error('Token exchange failed');
          const exData = await exRes.json();
          if (exData.error) throw new Error(typeof exData.error === 'string' ? exData.error : 'Exchange error');
          if (!exData.item_id) throw new Error('Missing item_id from server');

          if (!state.plaidLinked.find(p => p.item_id === exData.item_id)) {
            state.plaidLinked.push({
              item_id: sanitizeText(exData.item_id, 200),
              name: sanitizeText(exData.institution_name || institution),
            });
          }
          await syncTransactions();
          await syncAccounts();
          await saveState();
          toast(`Connected: ${institution}`);
          render();
        } catch(err) {
          toast('Connection failed: ' + sanitizeText(err.message));
        }
      },
      onExit: (err) => { if(err) console.warn('Plaid Link exit:', err.error_code); },
    }).open();
  } catch(err) {
    toast('Could not open Plaid: ' + sanitizeText(err.message));
  }
}

async function syncTransactions() {
  if (!state.backendOnline) return;
  state.syncing = true; render();
  try {
    const res = await fetch(`${BACKEND}/api/transactions`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.transactions)) throw new Error('Invalid response shape');

    // Validate every incoming Plaid transaction through the schema
    const validated = body.transactions
      .map(t => validateTransaction({...t, plaid:true}))
      .filter(Boolean)
      .slice(0, MAX_TRANSACTIONS);

    // Replace all Plaid transactions with the fresh fetch — never accumulate
    // This prevents doubling when re-linking or re-syncing the same bank
    const manual = state.transactions.filter(t => !t.plaid);
    const merged = [...validated, ...manual];
    merged.sort((a,b) => b.date.localeCompare(a.date));
    state.transactions = merged.slice(0, MAX_TRANSACTIONS);
    toast(`Synced ${validated.length} transactions`);
  } catch(err) {
    toast('Sync failed: ' + sanitizeText(err.message));
    console.error('Sync error:', err);
  }
  state.syncing = false;
}

async function syncAccounts() {
  if (!state.backendOnline) return;
  try {
    const res = await fetch(`${BACKEND}/api/linked_accounts`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body.accounts)) throw new Error('Invalid response shape');

    const validated = body.accounts
      .map(a => validateAccount({...a, plaid:true}))
      .filter(Boolean);

    const manual = state.accounts.filter(a => !a.plaid);
    state.accounts = [...validated, ...manual].slice(0, MAX_ACCOUNTS);
  } catch(err) {
    console.error('Account sync error:', err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(n) {
  const abs = Math.abs(Number(n));
  if (!isFinite(abs)) return '$0';
  return '$' + abs.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:0});
}
function thisMonth() { const n=new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}`; }
function txThisMonth() { const m=thisMonth(); return state.transactions.filter(t=>t.date.startsWith(m)); }
function totalIncome(txs) { return txs.filter(t=>t.type==='income').reduce((s,t)=>s+t.amount,0); }
function totalExpense(txs) { return txs.filter(t=>t.type==='expense').reduce((s,t)=>s+t.amount,0); }
function netWorth() { return state.accounts.reduce((s,a)=>s+a.balance,0); }
function pageIcon(p) { return {dashboard:'layout-dashboard',transactions:'arrows-exchange',budget:'chart-pie',goals:'target',accounts:'building-bank'}[p]||'circle'; }

// ── Safe DOM builder (never uses innerHTML with user data) ────────────────
function el(tag, attrs={}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === 'string') e.appendChild(document.createTextNode(child));
    else if (child instanceof Node) e.appendChild(child);
  }
  return e;
}

// Safe text node
function txt(str) { return document.createTextNode(String(str)); }

// For structural HTML only (no user data ever passes through here)
function html(parent, markup) { parent.innerHTML = markup; return parent; }

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  app.appendChild(makeSidebar());
  const main = el('div', {class:'main'});
  main.appendChild(makeTopbar());
  const content = el('div', {class:'content'});
  const page = VALID_PAGES.includes(state.page) ? state.page : 'dashboard';
  if (page==='dashboard') content.appendChild(makeDashboard());
  else if (page==='transactions') content.appendChild(makeTransactions());
  else if (page==='budget') content.appendChild(makeBudget());
  else if (page==='goals') content.appendChild(makeGoals());
  else if (page==='accounts') content.appendChild(makeAccounts());
  main.appendChild(content);
  app.appendChild(main);
  // Modals
  if (state.modals.addTx) app.appendChild(makeModal('addTx'));
  if (state.modals.addGoal) app.appendChild(makeModal('addGoal'));
  if (state.modals.addAccount) app.appendChild(makeModal('addAccount'));
  if (state.modals.editBudget) app.appendChild(makeModal('editBudget'));
  if (state.modals.contributeGoal) app.appendChild(makeModal('contributeGoal'));
  if (state.modals.editTag) app.appendChild(makeModal('editTag'));
  setTimeout(initCharts, 50);
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function makeSidebar() {
  const s = el('div', {class:'sidebar'});
  const logo = el('div', {class:'logo'});
  html(logo, `<div class="logo-text">Get There</div><div class="logo-sub">Financial Planner</div>`);
  s.appendChild(logo);

  const nav = el('div', {class:'nav'});
  VALID_PAGES.forEach(p => {
    const btn = el('button', {
      class: `nav-item ${state.page===p?'active':''}`,
      'aria-current': state.page===p ? 'page' : 'false',
      onclick: () => { state.page = p; render(); }
    });
    html(btn, `<i class="ti ti-${pageIcon(p)}" aria-hidden="true"></i>`);
    btn.appendChild(txt(p.charAt(0).toUpperCase()+p.slice(1)));
    nav.appendChild(btn);
  });
  s.appendChild(nav);

  const wrap = el('div', {class:'connect-btn-wrap'});
  if (state.plaidLinked.length) {
    const linked = el('div', {'style':'margin-bottom:8px'});
    state.plaidLinked.forEach(p => {
      const chip = el('span', {class:'linked-chip'});
      html(chip, `<i class="ti ti-check" style="font-size:10px" aria-hidden="true"></i>`);
      chip.appendChild(txt(p.name));
      linked.appendChild(chip);
    });
    wrap.appendChild(linked);
  }
  const connectBtn = el('button', {
    class:'connect-btn',
    'aria-label': state.backendOnline ? 'Connect a bank account via Plaid' : 'Backend server is offline',
    onclick: launchPlaidLink
  });
  html(connectBtn, `<i class="ti ti-link" aria-hidden="true"></i>`);
  connectBtn.appendChild(txt(state.backendOnline ? 'Connect bank' : 'Backend offline'));
  if (!state.backendOnline) {
    connectBtn.setAttribute('aria-disabled','true');
    connectBtn.style.opacity = '0.6';
    const hint = el('div', {style:'font-size:11px;color:var(--ink3);margin-top:6px;text-align:center'}, txt('Run server.js to enable'));
    wrap.appendChild(connectBtn);
    wrap.appendChild(hint);
  } else {
    wrap.appendChild(connectBtn);
  }
  s.appendChild(wrap);

  const nw = el('div', {class:'net-worth-pill'});
  html(nw, `<div class="nw-label">Net Worth</div>`);
  const nwVal = el('div', {class:'nw-value'}, txt(fmt(netWorth())));
  nw.appendChild(nwVal);
  s.appendChild(nw);
  return s;
}

// ── Topbar ─────────────────────────────────────────────────────────────────
function makeTopbar() {
  const t = el('div', {class:'topbar'});
  const titles = {dashboard:'Dashboard',transactions:'Transactions',budget:'Budget',goals:'Goals',accounts:'Accounts'};
  const title = el('h1', {class:'page-title'}, txt(titles[state.page] || ''));
  t.appendChild(title);
  const right = el('div', {class:'topbar-right'});
  if (state.page==='transactions') {
    const addBtn = el('button', {class:'btn btn-primary', onclick:()=>{state.modals.addTx=true;render();}});
    html(addBtn, `<i class="ti ti-plus" aria-hidden="true"></i> Add transaction`);
    right.appendChild(addBtn);
    if (state.plaidLinked.length) {
      const syncBtn = el('button', {
        class:`btn ${state.syncing?'':'btn-primary'}`,
        disabled: state.syncing,
        onclick: async()=>{await syncTransactions();await syncAccounts();await saveState();render();}
      });
      html(syncBtn, `<i class="ti ti-refresh" aria-hidden="true"></i>`);
      syncBtn.appendChild(txt(state.syncing ? ' Syncing…' : ' Sync Plaid'));
      right.appendChild(syncBtn);
    }
  } else if (state.page==='goals') {
    const b=el('button',{class:'btn btn-primary',onclick:()=>{state.modals.addGoal=true;render();}});
    html(b,`<i class="ti ti-plus" aria-hidden="true"></i> Add goal`);
    right.appendChild(b);
  } else if (state.page==='accounts') {
    const b=el('button',{class:'btn btn-primary',onclick:()=>{state.modals.addAccount=true;render();}});
    html(b,`<i class="ti ti-plus" aria-hidden="true"></i> Add account`);
    right.appendChild(b);
  } else if (state.page==='budget') {
    const b=el('button',{class:'btn btn-primary',onclick:()=>{state.modals.editBudget=true;render();}});
    html(b,`<i class="ti ti-edit" aria-hidden="true"></i> Edit budget`);
    right.appendChild(b);
  }
  t.appendChild(right);
  return t;
}

// ── Dashboard ──────────────────────────────────────────────────────────────
function makeDashboard() {
  const div = el('div');
  const txs = txThisMonth();
  const income = totalIncome(txs), expense = totalExpense(txs), savings = income - expense;
  const nw = netWorth();
  const plaidCount = state.transactions.filter(t=>t.plaid).length;

  // Status banner (structural HTML, no user data)
  const banner = el('div', {class:'plaid-banner'});
  if (!state.backendOnline) {
    html(banner, `<i class="ti ti-plug-connected-x" aria-hidden="true"></i>
      <div><div style="font-weight:500;font-size:14px;margin-bottom:2px">Connect your bank with Plaid</div>
      <div style="font-size:12px;color:var(--ink3)">Start your backend server, then click "Connect bank" in the sidebar.</div></div>`);
  } else if (plaidCount === 0) {
    html(banner, `<i class="ti ti-link" aria-hidden="true"></i>
      <div><div style="font-weight:500;font-size:14px;margin-bottom:2px">Backend connected — ready to link</div>
      <div style="font-size:12px;color:var(--ink3)">Click "Connect bank" in the sidebar to link your card or bank account.</div></div>`);
  } else {
    banner.style.background = 'var(--green-soft)';
    banner.style.borderColor = 'var(--green)';
    html(banner, `<i class="ti ti-circle-check" style="color:var(--green)" aria-hidden="true"></i><div></div>`);
    const btext = banner.querySelector('div');
    const btitle = el('div', {style:'font-weight:500;font-size:14px;margin-bottom:2px;color:var(--green)'}, txt(`${plaidCount} transactions synced`));
    const bsub = el('div', {style:'font-size:12px;color:var(--ink3)'});
    bsub.appendChild(txt(state.plaidLinked.map(p=>p.name).join(', ') + ' · Use "Sync Plaid" to refresh'));
    btext.appendChild(btitle);
    btext.appendChild(bsub);
  }
  div.appendChild(banner);

  // Stat cards
  const grid4 = el('div',{class:'grid-4'});
  const stats = [
    {label:'Net Worth', value:fmt(nw), sub:`${state.accounts.length} accounts`, color:''},
    {label:"This month's income", value:fmt(income), sub:`${txs.filter(t=>t.type==='income').length} sources`, color:'var(--green)'},
    {label:"This month's spending", value:fmt(expense), sub:`${txs.filter(t=>t.type==='expense').length} transactions`, color:'var(--red)'},
    {label:'Saved this month', value:fmt(savings), sub:`savings rate: ${income>0?sanitizePct(savings/income*100):0}%`, color:savings>=0?'var(--accent)':'var(--red)'},
  ];
  stats.forEach(s => {
    const c = el('div',{class:'card'});
    const label = el('div',{class:'card-title'},txt(s.label));
    const val = el('div',{class:'card-value'},txt(s.value));
    if (s.color) val.style.color = s.color;
    const sub = el('div',{class:'card-sub'},txt(s.sub));
    c.appendChild(label); c.appendChild(val); c.appendChild(sub);
    grid4.appendChild(c);
  });
  div.appendChild(grid4);

  // Middle row
  const grid2a = el('div',{class:'grid-2'});

  // Donut card
  const donutCard = el('div',{class:'card'});
  html(donutCard, `<div class="section-hdr"><div class="section-title">Spending by category</div></div>
    <div style="display:flex;align-items:center;gap:20px;">
      <div style="flex-shrink:0;width:140px;height:140px;">
        <canvas id="donut-chart" width="140" height="140" role="img" aria-label="Donut chart of spending by category"></canvas>
      </div>
      <div id="donut-legend" style="flex:1;font-size:13px;display:flex;flex-direction:column;gap:6px;" aria-hidden="true"></div>
    </div>`);
  grid2a.appendChild(donutCard);

  // Budget bars card
  const budgetCard = el('div',{class:'card'});
  const budgetHdr = el('div',{class:'section-hdr'});
  html(budgetHdr,'<div class="section-title">Budget status</div>');
  budgetCard.appendChild(budgetHdr);

  const expByCat = {};
  txs.filter(t=>t.type==='expense').forEach(t=>{ expByCat[t.cat]=(expByCat[t.cat]||0)+t.amount; });
  const budgetItems = Object.entries(state.budget).slice(0,5);
  if (!budgetItems.length) {
    budgetCard.appendChild(el('div',{class:'empty-state'},txt('No budget set yet')));
  } else {
    budgetItems.forEach(([cat,limit]) => {
      const spent = expByCat[cat]||0;
      const pct = sanitizePct(spent/limit*100);
      const cls = pct>=100?'red':pct>=80?'amber':'green';
      const row = el('div',{style:'margin-bottom:12px'});
      const rowHdr = el('div',{style:'display:flex;justify-content:space-between;font-size:13px;margin-bottom:5px'});
      rowHdr.appendChild(el('span',{},txt(cat)));
      const amts = el('span');
      amts.appendChild(txt(fmt(spent)+' '));
      const lim = el('span',{style:'color:var(--ink3)'},txt('/ '+fmt(limit)));
      amts.appendChild(lim);
      rowHdr.appendChild(amts);
      const bar = el('div',{class:'progress-wrap'});
      const fill = el('div',{class:`progress-bar ${cls}`,style:`width:${pct}%`,'role':'progressbar','aria-valuenow':String(pct),'aria-valuemin':'0','aria-valuemax':'100','aria-label':`${cat} budget: ${pct}% used`});
      bar.appendChild(fill);
      row.appendChild(rowHdr); row.appendChild(bar);
      budgetCard.appendChild(row);
    });
  }
  grid2a.appendChild(budgetCard);
  div.appendChild(grid2a);

  // Bottom row
  const grid2b = el('div',{class:'grid-2'});

  // Recent transactions card (uses el() for user data, never innerHTML)
  const txCard = el('div',{class:'card'});
  const txHdr = el('div',{class:'section-hdr'});
  html(txHdr,'<div class="section-title">Recent transactions</div>');
  const txViewAll = el('button',{class:'btn btn-sm',onclick:()=>{state.page='transactions';render();}},txt('View all'));
  txHdr.appendChild(txViewAll);
  txCard.appendChild(txHdr);
  const tbl = el('table');
  html(tbl,'<thead><tr><th>Description</th><th>Category</th><th style="text-align:right">Amount</th></tr></thead>');
  const tbody = el('tbody');
  state.transactions.slice(0,6).forEach(t => {
    const tr = el('tr');
    const tdDesc = el('td');
    tdDesc.appendChild(txt(t.desc));
    if (t.plaid) {
      const badge = el('span',{class:'badge badge-accent',style:'margin-left:6px;font-size:10px'},txt('Plaid'));
      tdDesc.appendChild(badge);
    }
    const tdCat = el('td');
    const chip = el('div',{class:'chip'});
    const dot = el('div',{class:'dot',style:`background:${CAT_COLORS[t.cat]||'#888'}`});
    chip.appendChild(dot);
    chip.appendChild(txt(t.cat));
    tdCat.appendChild(chip);
    const tdAmt = el('td',{style:`text-align:right;font-weight:500;color:${t.type==='income'?'var(--green)':'var(--red)'}`},
      txt((t.type==='income'?'+':'-')+fmt(t.amount)));
    tr.appendChild(tdDesc); tr.appendChild(tdCat); tr.appendChild(tdAmt);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);
  txCard.appendChild(tbl);
  grid2b.appendChild(txCard);

  // Goals card
  const goalsCard = el('div',{class:'card'});
  html(goalsCard,'<div class="section-hdr"><div class="section-title">Goals progress</div></div>');
  const goalsInner = el('div',{style:'display:flex;flex-direction:column;gap:16px'});
  state.goals.slice(0,3).forEach(g => {
    const pct = sanitizePct(g.saved/g.target*100);
    const days = Math.ceil((new Date(g.deadline)-new Date())/86400000);
    const gDiv = el('div');
    const gHdr = el('div',{style:'display:flex;justify-content:space-between;align-items:center;margin-bottom:6px'});
    const gName = el('span',{style:'font-size:14px;font-weight:500'});
    html(gName,`<i class="ti ${escapeHtml(g.icon)}" style="color:${escapeHtml(g.color)};margin-right:6px" aria-hidden="true"></i>`);
    gName.appendChild(txt(g.name));
    const gPct = el('span',{style:'font-size:12px;color:var(--ink3)'},txt(`${pct}%`));
    gHdr.appendChild(gName); gHdr.appendChild(gPct);
    const bar = el('div',{class:'progress-wrap'});
    const fill = el('div',{class:'progress-bar',style:`width:${pct}%;background:${escapeHtml(g.color)}`,'role':'progressbar','aria-valuenow':String(pct),'aria-valuemin':'0','aria-valuemax':'100'});
    bar.appendChild(fill);
    const gFtr = el('div',{style:'display:flex;justify-content:space-between;font-size:11px;color:var(--ink3);margin-top:4px'});
    gFtr.appendChild(txt(`${fmt(g.saved)} of ${fmt(g.target)}`));
    gFtr.appendChild(txt(days>0?`${days} days left`:'Overdue'));
    gDiv.appendChild(gHdr); gDiv.appendChild(bar); gDiv.appendChild(gFtr);
    goalsInner.appendChild(gDiv);
  });
  goalsCard.appendChild(goalsInner);
  grid2b.appendChild(goalsCard);
  div.appendChild(grid2b);

  // Store for chart init
  window._donutData = expByCat;
  return div;
}

// ── Transactions page ──────────────────────────────────────────────────────
function makeTransactions() {
  const div = el('div');
  const filter = VALID_FILTERS.includes(state.txFilter) ? state.txFilter : 'all';
  const sorted = state.transactions.slice().sort((a,b)=>b.date.localeCompare(a.date));
  const filtered = filter==='all' ? sorted : sorted.filter(t=>t.type===filter);

  const tabs = el('div',{class:'tabs'});
  ['all','income','expense'].forEach(f => {
    const btn = el('button',{
      class:`tab ${filter===f?'active':''}`,
      'aria-pressed': String(filter===f),
      onclick:()=>{state.txFilter=f;render();}
    }, txt(f.charAt(0).toUpperCase()+f.slice(1)));
    tabs.appendChild(btn);
  });
  div.appendChild(tabs);

  const card = el('div',{class:'card'});
  const tbl = el('table');
  html(tbl,'<thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Source</th><th style="text-align:right">Amount</th><th></th></tr></thead>');
  const tbody = el('tbody');
  if (!filtered.length) {
    const tr = el('tr');
    const td = el('td',{colspan:'6',style:'text-align:center;color:var(--ink3);padding:32px'},txt('No transactions found'));
    tr.appendChild(td); tbody.appendChild(tr);
  } else {
    filtered.forEach(t => {
      const tr = el('tr');
      tr.appendChild(el('td',{style:'color:var(--ink3);white-space:nowrap'},txt(t.date)));
      const tdDesc = el('td',{style:'font-weight:500'});
      tdDesc.appendChild(txt(t.desc));
      if (t.plaid) tdDesc.appendChild(el('span',{class:'badge badge-accent',style:'margin-left:6px;font-size:10px'},txt('Plaid')));
      const tdCat = el('td');
      const chip = el('div',{class:'chip'});
      chip.appendChild(el('div',{class:'dot',style:`background:${CAT_COLORS[t.cat]||'#888'}`}));
      chip.appendChild(txt(t.cat));
      tdCat.appendChild(chip);
      tr.appendChild(tdDesc); tr.appendChild(tdCat);
      tr.appendChild(el('td',{style:'color:var(--ink2)'},txt(t.account)));
      tr.appendChild(el('td',{style:`text-align:right;font-weight:500;color:${t.type==='income'?'var(--green)':'var(--red)'}`},
        txt((t.type==='income'?'+':'-')+fmt(t.amount))));
      const tdDel = el('td',{style:'white-space:nowrap;display:flex;gap:4px;padding:8px 12px'});
      const editTagBtn = el('button',{
        class:'btn btn-sm',
        'aria-label':`Edit tag for: ${t.desc}`,
        onclick:()=>{ state.modals.editTag = t.desc; render(); }
      });
      html(editTagBtn,`<i class="ti ti-tag" aria-hidden="true"></i>`);
      tdDel.appendChild(editTagBtn);
      if (!t.plaid) {
        const delBtn = el('button',{
          class:'btn btn-sm btn-danger',
          'aria-label':`Delete transaction: ${t.desc}`,
          onclick:()=>{
            state.transactions = state.transactions.filter(x=>x.id!==t.id);
            saveState(); render();
          }
        });
        html(delBtn,`<i class="ti ti-trash" aria-hidden="true"></i>`);
        tdDel.appendChild(delBtn);
      }
      tr.appendChild(tdDel);
      tbody.appendChild(tr);
    });
  }
  tbl.appendChild(tbody); card.appendChild(tbl); div.appendChild(card);

  const chartWrap = el('div',{style:'margin-top:20px'});
  const chartCard = el('div',{class:'card'});
  html(chartCard,`<div class="section-title" style="margin-bottom:12px">6-month overview</div>
    <div style="height:180px;position:relative;"><canvas id="trend-chart" role="img" aria-label="Bar chart showing income vs expenses over last 6 months"></canvas></div>`);
  chartWrap.appendChild(chartCard);
  div.appendChild(chartWrap);
  return div;
}

// ── Budget page ────────────────────────────────────────────────────────────
function makeBudget() {
  const div = el('div');
  const txs = txThisMonth();
  const expByCat = {};
  txs.filter(t=>t.type==='expense').forEach(t=>{ expByCat[t.cat]=(expByCat[t.cat]||0)+t.amount; });
  const totalBudget = Object.values(state.budget).reduce((s,v)=>s+v,0);
  const totalSpent = Object.keys(state.budget).reduce((s,k)=>s+(expByCat[k]||0),0);

  if (!Object.keys(state.budget).length) {
    div.appendChild(el('div',{class:'card'},el('div',{class:'empty-state'},txt('No budget set. Click "Edit budget" to get started.'))));
    return div;
  }

  const g3 = el('div',{class:'grid-3',style:'margin-bottom:20px'});
  [
    {label:'Total budget', val:fmt(totalBudget), sub:'monthly limit'},
    {label:'Spent so far', val:fmt(totalSpent), sub:`${sanitizePct(totalSpent/totalBudget*100)}% used`, color:totalSpent>totalBudget?'var(--red)':''},
    {label:'Remaining', val:fmt(totalBudget-totalSpent), sub:totalBudget-totalSpent>=0?'under budget':'over budget', color:totalBudget-totalSpent>=0?'var(--green)':'var(--red)'},
  ].forEach(s => {
    const c = el('div',{class:'card'});
    c.appendChild(el('div',{class:'card-title'},txt(s.label)));
    const v = el('div',{class:'card-value'},txt(s.val));
    if (s.color) v.style.color = s.color;
    c.appendChild(v);
    c.appendChild(el('div',{class:'card-sub'},txt(s.sub)));
    g3.appendChild(c);
  });
  div.appendChild(g3);

  const card = el('div',{class:'card'});
  Object.entries(state.budget).forEach(([cat,limit]) => {
    const spent = expByCat[cat]||0;
    const pct = sanitizePct(spent/limit*100);
    const cls = pct>=100?'red':pct>=80?'amber':'green';
    const badgeText = pct>=100?'Over':pct>=80?'Near':'OK';
    const badgeCls = pct>=100?'badge-red':pct>=80?'badge-amber':'badge-green';

    const row = el('div',{style:'padding:14px 0;border-bottom:.5px solid var(--border)'});
    const hdr = el('div',{style:'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'});
    const left = el('div',{style:'display:flex;align-items:center;gap:8px'});
    left.appendChild(el('div',{class:'dot',style:`background:${CAT_COLORS[cat]||'#888'};width:10px;height:10px`}));
    left.appendChild(el('span',{style:'font-weight:500'},txt(cat)));
    const right = el('div',{style:'display:flex;align-items:center;gap:10px'});
    right.appendChild(el('span',{class:`badge ${badgeCls}`},txt(badgeText)));
    const amts = el('span',{style:'font-size:14px'});
    amts.appendChild(txt(fmt(spent)+' '));
    amts.appendChild(el('span',{style:'color:var(--ink3)'},txt('/ '+fmt(limit))));
    right.appendChild(amts);
    hdr.appendChild(left); hdr.appendChild(right);
    const barWrap = el('div',{class:'progress-wrap'});
    barWrap.appendChild(el('div',{class:`progress-bar ${cls}`,style:`width:${pct}%`,'role':'progressbar','aria-valuenow':String(pct),'aria-valuemin':'0','aria-valuemax':'100','aria-label':`${cat}: ${pct}% of budget used`}));
    row.appendChild(hdr); row.appendChild(barWrap);
    card.appendChild(row);
  });
  div.appendChild(card);
  return div;
}

// ── Goals page ─────────────────────────────────────────────────────────────
function makeGoals() {
  const div = el('div');
  if (!state.goals.length) {
    div.appendChild(el('div',{class:'card'},el('div',{class:'empty-state'},txt('No goals yet. Add your first goal!'))));
    return div;
  }
  const grid = el('div',{class:'grid-2'});
  state.goals.forEach(g => {
    const pct = sanitizePct(g.saved/g.target*100);
    const days = Math.ceil((new Date(g.deadline)-new Date())/86400000);
    const card = el('div',{class:'goal-card'});

    const hdr = el('div',{style:'display:flex;align-items:center;gap:10px;margin-bottom:8px'});
    const iconWrap = el('div',{style:`width:36px;height:36px;border-radius:10px;background:${escapeHtml(g.color)}22;display:flex;align-items:center;justify-content:center`});
    html(iconWrap,`<i class="ti ${escapeHtml(g.icon)}" style="color:${escapeHtml(g.color)};font-size:18px" aria-hidden="true"></i>`);
    const info = el('div');
    info.appendChild(el('div',{style:'font-weight:500;font-size:15px'},txt(g.name)));
    const deadlineFmt = new Date(g.deadline).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    info.appendChild(el('div',{style:'font-size:12px;color:var(--ink3)'},txt(`Due ${deadlineFmt} · ${days>0?days+' days left':'Overdue'}`)));
    const pctEl = el('div',{style:`margin-left:auto;font-family:'Fraunces',serif;font-size:22px;font-weight:500;color:${escapeHtml(g.color)}`},txt(`${pct}%`));
    hdr.appendChild(iconWrap); hdr.appendChild(info); hdr.appendChild(pctEl);

    const barWrap = el('div',{class:'progress-wrap',style:'margin-bottom:8px'});
    barWrap.appendChild(el('div',{class:'progress-bar',style:`width:${pct}%;background:${escapeHtml(g.color)}`,'role':'progressbar','aria-valuenow':String(pct),'aria-valuemin':'0','aria-valuemax':'100','aria-label':`${g.name}: ${pct}% complete`}));

    const amts = el('div',{style:'display:flex;justify-content:space-between;font-size:13px;margin-bottom:12px'});
    amts.appendChild(el('span',{},...[txt('Saved: '),el('strong',{},txt(fmt(g.saved)))]));
    amts.appendChild(el('span',{style:'color:var(--ink3)'},txt('Target: '+fmt(g.target))));

    const actions = el('div',{style:'display:flex;gap:6px'});
    const contBtn = el('button',{class:'btn btn-primary btn-sm',onclick:()=>{state.modals.contributeGoal=g.id;render();}});
    html(contBtn,`<i class="ti ti-plus" aria-hidden="true"></i> Contribute`);
    const delBtn = el('button',{class:'btn btn-sm btn-danger','aria-label':`Delete goal: ${g.name}`,onclick:()=>{state.goals=state.goals.filter(x=>x.id!==g.id);saveState();render();}});
    html(delBtn,`<i class="ti ti-trash" aria-hidden="true"></i>`);
    actions.appendChild(contBtn); actions.appendChild(delBtn);

    card.appendChild(hdr); card.appendChild(barWrap); card.appendChild(amts); card.appendChild(actions);
    grid.appendChild(card);
  });
  div.appendChild(grid);
  return div;
}

// ── Accounts page ──────────────────────────────────────────────────────────
function makeAccounts() {
  const div = el('div');
  const nw = netWorth();
  const assets = state.accounts.filter(a=>a.balance>0).reduce((s,a)=>s+a.balance,0);
  const liabs = Math.abs(state.accounts.filter(a=>a.balance<0).reduce((s,a)=>s+a.balance,0));

  const g3 = el('div',{class:'grid-3',style:'margin-bottom:20px'});
  [{label:'Total assets',val:fmt(assets),color:'var(--green)'},
   {label:'Total liabilities',val:fmt(liabs),color:'var(--red)'},
   {label:'Net worth',val:fmt(nw),color:'var(--accent)'}
  ].forEach(s => {
    const c = el('div',{class:'card'});
    c.appendChild(el('div',{class:'card-title'},txt(s.label)));
    const v = el('div',{class:'card-value'},txt(s.val));
    v.style.color = s.color;
    c.appendChild(v);
    g3.appendChild(c);
  });
  div.appendChild(g3);

  const card = el('div',{class:'card'});
  const tbl = el('table');
  html(tbl,'<thead><tr><th>Account</th><th>Type</th><th>Source</th><th style="text-align:right">Balance</th><th></th></tr></thead>');
  const tbody = el('tbody');
  state.accounts.forEach(a => {
    const tr = el('tr');
    const tdName = el('td');
    const wrap = el('div',{style:'display:flex;align-items:center;gap:10px'});
    const icon = el('div',{style:'width:32px;height:32px;border-radius:8px;background:var(--accent-soft);display:flex;align-items:center;justify-content:center'});
    html(icon,`<i class="ti ${a.type==='Investment'?'ti-trending-up':a.type==='Credit'?'ti-credit-card':'ti-building-bank'}" style="color:var(--accent);font-size:15px" aria-hidden="true"></i>`);
    wrap.appendChild(icon);
    wrap.appendChild(el('span',{style:'font-weight:500'},txt(a.name)));
    tdName.appendChild(wrap);
    tr.appendChild(tdName);
    tr.appendChild(el('td',{},el('span',{class:'badge badge-accent'},txt(a.type))));
    tr.appendChild(el('td',{},el('span',{class:`badge ${a.plaid?'badge-green':''}`},txt(a.plaid?'Plaid':'Manual'))));
    const balColor = a.balance>=0?'var(--ink)':'var(--red)';
    tr.appendChild(el('td',{style:`text-align:right;font-weight:500;font-size:16px;color:${balColor}`},
      txt((a.balance>=0?'':'-')+fmt(Math.abs(a.balance)))));
    const tdDel = el('td');
    if (!a.plaid) {
      const delBtn = el('button',{class:'btn btn-sm btn-danger','aria-label':`Delete account: ${a.name}`,onclick:()=>{state.accounts=state.accounts.filter(x=>x.id!==a.id);saveState();render();}});
      html(delBtn,`<i class="ti ti-trash" aria-hidden="true"></i>`);
      tdDel.appendChild(delBtn);
    }
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); card.appendChild(tbl); div.appendChild(card);
  return div;
}

// ── Modals ─────────────────────────────────────────────────────────────────
function makeModalShell(title, onClose) {
  const overlay = el('div',{class:'modal-overlay',role:'dialog','aria-modal':'true','aria-label':title});
  overlay.addEventListener('click', e => { if(e.target===overlay) onClose(); });
  const modal = el('div',{class:'modal'});
  const hdr = el('div',{style:'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px'});
  hdr.appendChild(el('h2',{class:'modal-title',style:'margin-bottom:0'},txt(title)));
  const closeBtn = el('button',{class:'btn btn-sm','aria-label':'Close dialog',onclick:onClose});
  html(closeBtn,`<i class="ti ti-x" aria-hidden="true"></i>`);
  hdr.appendChild(closeBtn);
  modal.appendChild(hdr);
  overlay.appendChild(modal);
  return {overlay, modal};
}

function fieldErr(id) { return el('div',{class:'field-error',id}); }

function showErr(id, msg) {
  const e = document.getElementById(id);
  if (e) { e.textContent = msg; e.classList.add('show'); }
}
function clearErr(id) {
  const e = document.getElementById(id);
  if (e) { e.textContent=''; e.classList.remove('show'); }
}

function makeModal(type) {
  if (type==='addTx') return makeAddTxModal();
  if (type==='addGoal') return makeAddGoalModal();
  if (type==='addAccount') return makeAddAccountModal();
  if (type==='editBudget') return makeEditBudgetModal();
  if (type==='contributeGoal') return makeContributeModal();
  if (type==='editTag') return makeEditTagModal();
  return el('div');
}

function makeAddTxModal() {
  const close = () => { state.modals.addTx=false; render(); };
  const {overlay, modal} = makeModalShell('Add transaction', close);

  const typeRow = el('div',{class:'form-group'});
  typeRow.appendChild(el('label',{class:'form-label',for:'tx-type'},txt('Type')));
  const typeEl = el('select',{class:'form-select',id:'tx-type'});
  ['expense','income'].forEach(v => typeEl.appendChild(el('option',{value:v},txt(v.charAt(0).toUpperCase()+v.slice(1)))));
  typeRow.appendChild(typeEl);
  modal.appendChild(typeRow);

  const descRow = el('div',{class:'form-group'});
  descRow.appendChild(el('label',{class:'form-label',for:'tx-desc'},txt('Description')));
  const descEl = el('input',{class:'form-input',id:'tx-desc',type:'text',placeholder:'e.g. Coffee, Netflix…',maxlength:String(MAX_DESC_LEN),'aria-describedby':'tx-desc-err'});
  descRow.appendChild(descEl);
  descRow.appendChild(fieldErr('tx-desc-err'));
  modal.appendChild(descRow);

  const midRow = el('div',{class:'form-row'});
  const amtGrp = el('div',{class:'form-group'});
  amtGrp.appendChild(el('label',{class:'form-label',for:'tx-amount'},txt('Amount ($)')));
  const amtEl = el('input',{class:'form-input',id:'tx-amount',type:'number',min:'0.01',max:String(MAX_AMOUNT),step:'0.01',placeholder:'0.00','aria-describedby':'tx-amount-err'});
  amtGrp.appendChild(amtEl);
  amtGrp.appendChild(fieldErr('tx-amount-err'));
  const dateGrp = el('div',{class:'form-group'});
  dateGrp.appendChild(el('label',{class:'form-label',for:'tx-date'},txt('Date')));
  const dateEl = el('input',{class:'form-input',id:'tx-date',type:'date',value:new Date().toISOString().slice(0,10),'aria-describedby':'tx-date-err'});
  dateGrp.appendChild(dateEl);
  dateGrp.appendChild(fieldErr('tx-date-err'));
  midRow.appendChild(amtGrp); midRow.appendChild(dateGrp);
  modal.appendChild(midRow);

  const botRow = el('div',{class:'form-row'});
  const catGrp = el('div',{class:'form-group'});
  catGrp.appendChild(el('label',{class:'form-label',for:'tx-cat'},txt('Category')));
  const catEl = el('select',{class:'form-select',id:'tx-cat','aria-describedby':'tx-cat-err'});
  catEl.appendChild(el('option',{value:''},txt('Select…')));
  catGrp.appendChild(catEl);
  catGrp.appendChild(fieldErr('tx-cat-err'));

  const acctGrp = el('div',{class:'form-group'});
  acctGrp.appendChild(el('label',{class:'form-label',for:'tx-account'},txt('Account')));
  const acctEl = el('select',{class:'form-select',id:'tx-account'});
  state.accounts.map(a=>a.name).forEach(n => acctEl.appendChild(el('option',{value:n},txt(n))));
  acctEl.appendChild(el('option',{value:'Other'},txt('Other')));
  acctGrp.appendChild(acctEl);
  botRow.appendChild(catGrp); botRow.appendChild(acctGrp);
  modal.appendChild(botRow);

  function refreshCats() {
    const cats = typeEl.value==='income' ? INCOME_CATS : EXPENSE_CATS;
    catEl.innerHTML='';
    catEl.appendChild(el('option',{value:''},txt('Select…')));
    cats.forEach(c => catEl.appendChild(el('option',{value:c},txt(c))));
  }
  refreshCats();
  typeEl.addEventListener('change', refreshCats);

  const saveBtn = el('button',{class:'btn btn-primary',style:'width:100%',onclick:()=>{
    let ok = true;
    const desc = sanitizeText(descEl.value, MAX_DESC_LEN);
    if (!desc) { showErr('tx-desc-err','Description is required'); ok=false; } else clearErr('tx-desc-err');
    const amount = sanitizeAmount(amtEl.value);
    if (amount===null||amount<=0) { showErr('tx-amount-err','Enter a valid amount'); ok=false; } else clearErr('tx-amount-err');
    const date = sanitizeDate(dateEl.value);
    if (!date) { showErr('tx-date-err','Enter a valid date'); ok=false; } else clearErr('tx-date-err');
    const cat = sanitizeEnum(catEl.value, ALL_CATS);
    if (!cat) { showErr('tx-cat-err','Select a category'); ok=false; } else clearErr('tx-cat-err');
    const type = sanitizeEnum(typeEl.value, VALID_TYPES);
    const account = sanitizeText(acctEl.value, MAX_NAME_LEN) || 'Other';
    if (!ok) return;
    const tx = validateTransaction({id:'t'+Date.now(), desc, amount, date, type, cat, account});
    if (!tx) { toast('Invalid transaction data'); return; }
    if (state.transactions.length >= MAX_TRANSACTIONS) { toast('Transaction limit reached'); return; }
    state.transactions.unshift(tx);
    saveState(); close();
  }},txt('Add transaction'));
  modal.appendChild(saveBtn);
  return overlay;
}

function makeAddGoalModal() {
  const close = () => { state.modals.addGoal=false; render(); };
  const {overlay, modal} = makeModalShell('New goal', close);

  const nameGrp = el('div',{class:'form-group'});
  nameGrp.appendChild(el('label',{class:'form-label',for:'g-name'},txt('Goal name')));
  const nameEl = el('input',{class:'form-input',id:'g-name',type:'text',placeholder:'e.g. Emergency fund, Vacation…',maxlength:String(MAX_NAME_LEN),'aria-describedby':'g-name-err'});
  nameGrp.appendChild(nameEl);
  nameGrp.appendChild(fieldErr('g-name-err'));
  modal.appendChild(nameGrp);

  const row = el('div',{class:'form-row'});
  const tgtGrp = el('div',{class:'form-group'});
  tgtGrp.appendChild(el('label',{class:'form-label',for:'g-target'},txt('Target ($)')));
  const tgtEl = el('input',{class:'form-input',id:'g-target',type:'number',min:'1',max:String(MAX_AMOUNT),placeholder:'10000','aria-describedby':'g-target-err'});
  tgtGrp.appendChild(tgtEl); tgtGrp.appendChild(fieldErr('g-target-err'));
  const savGrp = el('div',{class:'form-group'});
  savGrp.appendChild(el('label',{class:'form-label',for:'g-saved'},txt('Already saved ($)')));
  const savEl = el('input',{class:'form-input',id:'g-saved',type:'number',min:'0',max:String(MAX_AMOUNT),placeholder:'0',value:'0'});
  savGrp.appendChild(savEl);
  row.appendChild(tgtGrp); row.appendChild(savGrp);
  modal.appendChild(row);

  const dlGrp = el('div',{class:'form-group'});
  dlGrp.appendChild(el('label',{class:'form-label',for:'g-deadline'},txt('Target date')));
  const dlEl = el('input',{class:'form-input',id:'g-deadline',type:'date','aria-describedby':'g-deadline-err'});
  dlGrp.appendChild(dlEl); dlGrp.appendChild(fieldErr('g-deadline-err'));
  modal.appendChild(dlGrp);

  const saveBtn = el('button',{class:'btn btn-primary',style:'width:100%',onclick:()=>{
    let ok=true;
    const name = sanitizeText(nameEl.value, MAX_NAME_LEN);
    if (!name) { showErr('g-name-err','Name is required'); ok=false; } else clearErr('g-name-err');
    const target = sanitizeAmount(tgtEl.value);
    if (!target||target<=0) { showErr('g-target-err','Enter a valid target'); ok=false; } else clearErr('g-target-err');
    const deadline = sanitizeDate(dlEl.value);
    if (!deadline) { showErr('g-deadline-err','Enter a valid date'); ok=false; } else clearErr('g-deadline-err');
    const saved = Math.min(sanitizeAmount(savEl.value)||0, target||0);
    if (!ok) return;
    const idx = state.goals.length % GOAL_ICONS.length;
    const g = validateGoal({id:'g'+Date.now(),name,target,saved,deadline,icon:GOAL_ICONS[idx],color:GOAL_COLORS[idx]});
    if (!g) { toast('Invalid goal data'); return; }
    if (state.goals.length >= MAX_GOALS) { toast('Goal limit reached'); return; }
    state.goals.push(g);
    saveState(); close();
  }},txt('Create goal'));
  modal.appendChild(saveBtn);
  return overlay;
}

function makeAddAccountModal() {
  const close = () => { state.modals.addAccount=false; render(); };
  const {overlay, modal} = makeModalShell('Add account', close);

  const nameGrp = el('div',{class:'form-group'});
  nameGrp.appendChild(el('label',{class:'form-label',for:'ac-name'},txt('Account name')));
  const nameEl = el('input',{class:'form-input',id:'ac-name',type:'text',placeholder:'e.g. Chase Checking…',maxlength:String(MAX_NAME_LEN),'aria-describedby':'ac-name-err'});
  nameGrp.appendChild(nameEl); nameGrp.appendChild(fieldErr('ac-name-err'));
  modal.appendChild(nameGrp);

  const row = el('div',{class:'form-row'});
  const typeGrp = el('div',{class:'form-group'});
  typeGrp.appendChild(el('label',{class:'form-label',for:'ac-type'},txt('Type')));
  const typeEl = el('select',{class:'form-select',id:'ac-type'});
  VALID_ACCOUNT_TYPES.forEach(v => typeEl.appendChild(el('option',{value:v},txt(v))));
  typeGrp.appendChild(typeEl);
  const balGrp = el('div',{class:'form-group'});
  balGrp.appendChild(el('label',{class:'form-label',for:'ac-bal'},txt('Balance ($)')));
  const balEl = el('input',{class:'form-input',id:'ac-bal',type:'number',step:'0.01',placeholder:'0','aria-describedby':'ac-bal-err'});
  balGrp.appendChild(balEl); balGrp.appendChild(fieldErr('ac-bal-err'));
  row.appendChild(typeGrp); row.appendChild(balGrp);
  modal.appendChild(row);
  modal.appendChild(el('p',{style:'font-size:12px;color:var(--ink3);margin-bottom:12px'},txt('For credit cards, enter a negative balance (e.g. -2500)')));

  const saveBtn = el('button',{class:'btn btn-primary',style:'width:100%',onclick:()=>{
    let ok=true;
    const name = sanitizeText(nameEl.value, MAX_NAME_LEN);
    if (!name) { showErr('ac-name-err','Name is required'); ok=false; } else clearErr('ac-name-err');
    const balance = sanitizeBalance(balEl.value);
    if (balance===null) { showErr('ac-bal-err','Enter a valid balance'); ok=false; } else clearErr('ac-bal-err');
    const type = sanitizeEnum(typeEl.value, VALID_ACCOUNT_TYPES)||'Bank';
    if (!ok) return;
    const acct = validateAccount({id:'a'+Date.now(),name,type,balance});
    if (!acct) { toast('Invalid account data'); return; }
    if (state.accounts.length >= MAX_ACCOUNTS) { toast('Account limit reached'); return; }
    state.accounts.push(acct);
    saveState(); close();
  }},txt('Add account'));
  modal.appendChild(saveBtn);
  return overlay;
}

function makeEditBudgetModal() {
  const close = () => { state.modals.editBudget=false; render(); };
  const {overlay, modal} = makeModalShell('Monthly budget', close);

  const scroller = el('div',{style:'max-height:320px;overflow-y:auto;padding-right:4px'});
  const inputs = [];
  EXPENSE_CATS.forEach(cat => {
    const grp = el('div',{class:'form-group'});
    grp.appendChild(el('label',{class:'form-label',for:`bgt-${cat}`},txt(cat)));
    const inp = el('input',{class:'form-input',id:`bgt-${cat}`,type:'number',min:'0',max:String(MAX_AMOUNT),placeholder:'0',value:String(state.budget[cat]||'')});
    grp.appendChild(inp);
    scroller.appendChild(grp);
    inputs.push({cat, inp});
  });
  modal.appendChild(scroller);

  const saveBtn = el('button',{class:'btn btn-primary',style:'width:100%;margin-top:12px',onclick:()=>{
    const raw = {};
    inputs.forEach(({cat, inp}) => { raw[cat] = inp.value; });
    state.budget = validateBudget(raw);
    saveState(); close();
  }},txt('Save budget'));
  modal.appendChild(saveBtn);
  return overlay;
}

function makeContributeModal() {
  const gid = state.modals.contributeGoal;
  const goal = state.goals.find(g=>g.id===gid);
  const close = () => { state.modals.contributeGoal=null; render(); };
  if (!goal) { close(); return el('div'); }
  const {overlay, modal} = makeModalShell('Contribute to goal', close);

  const iconDiv = el('div',{style:'text-align:center;margin-bottom:20px'});
  const iconWrap = el('div',{style:'font-size:32px;margin-bottom:8px'});
  html(iconWrap,`<i class="ti ${escapeHtml(goal.icon)}" style="color:${escapeHtml(goal.color)}" aria-hidden="true"></i>`);
  iconDiv.appendChild(iconWrap);
  iconDiv.appendChild(el('div',{style:'font-size:15px;font-weight:500;margin-bottom:4px'},txt(goal.name)));
  iconDiv.appendChild(el('div',{style:'font-size:13px;color:var(--ink3)'},txt(`${fmt(goal.saved)} of ${fmt(goal.target)}`)));
  modal.appendChild(iconDiv);

  const grp = el('div',{class:'form-group'});
  grp.appendChild(el('label',{class:'form-label',for:'contrib-amt'},txt('Amount ($)')));
  const amtEl = el('input',{class:'form-input',id:'contrib-amt',type:'number',min:'0.01',max:String(MAX_AMOUNT),step:'0.01',placeholder:'500','aria-describedby':'contrib-err'});
  grp.appendChild(amtEl);
  grp.appendChild(fieldErr('contrib-err'));
  modal.appendChild(grp);

  const saveBtn = el('button',{class:'btn btn-primary',style:'width:100%',onclick:()=>{
    const amt = sanitizeAmount(amtEl.value);
    if (!amt||amt<=0) { showErr('contrib-err','Enter a valid amount'); return; }
    clearErr('contrib-err');
    goal.saved = Math.min(goal.target, Math.round((goal.saved + amt)*100)/100);
    saveState(); close();
  }},txt('Add contribution'));
  modal.appendChild(saveBtn);
  return overlay;
}


function makeEditTagModal() {
  const desc = state.modals.editTag;
  const close = () => { state.modals.editTag = null; render(); };
  const matching = state.transactions.filter(t => t.desc === desc);
  const currentCat = matching[0]?.cat || '';
  const currentType = matching[0]?.type || 'expense';
  const {overlay, modal} = makeModalShell('Edit tag', close);

  // Info line showing how many will be updated
  const info = el('div',{style:'font-size:13px;color:var(--ink3);margin-bottom:16px;padding:10px 12px;background:var(--surface2);border-radius:var(--radius-sm)'});
  info.appendChild(el('strong',{},txt(sanitizeText(desc))));
  info.appendChild(txt(` · ${matching.length} transaction${matching.length!==1?'s':''} will be updated`));
  modal.appendChild(info);

  const catGrp = el('div',{class:'form-group'});
  catGrp.appendChild(el('label',{class:'form-label',for:'et-cat'},txt('Category')));
  const catEl = el('select',{class:'form-select',id:'et-cat'});
  const cats = currentType === 'income' ? INCOME_CATS : EXPENSE_CATS;
  cats.forEach(c => {
    const opt = el('option',{value:c},txt(c));
    if (c === currentCat) opt.setAttribute('selected','selected');
    catEl.appendChild(opt);
  });
  catGrp.appendChild(catEl);
  modal.appendChild(catGrp);

  const saveBtn = el('button',{class:'btn btn-primary',style:'width:100%;margin-top:4px',onclick:()=>{
    const newCat = sanitizeEnum(catEl.value, ALL_CATS);
    if (!newCat) { toast('Select a valid category'); return; }
    state.transactions = state.transactions.map(t =>
      t.desc === desc ? {...t, cat: newCat} : t
    );
    saveState();
    toast(`Updated ${matching.length} transaction${matching.length!==1?'s':''}`);
    close();
  }},txt('Save'));
  modal.appendChild(saveBtn);
  return overlay;
}

// ── Charts ─────────────────────────────────────────────────────────────────
function initCharts() {
  const dc = document.getElementById('donut-chart');
  if (dc && window._donutData) {
    const entries = Object.entries(window._donutData).sort((a,b)=>b[1]-a[1]).slice(0,6);
    if (entries.length) {
      new Chart(dc, {
        type:'doughnut',
        data:{labels:entries.map(e=>e[0]),datasets:[{data:entries.map(e=>e[1]),backgroundColor:entries.map(e=>CAT_COLORS[e[0]]||'#888'),borderWidth:2,borderColor:'transparent'}]},
        options:{responsive:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+fmt(ctx.raw)}}},cutout:'68%'}
      });
      const leg = document.getElementById('donut-legend');
      if (leg) {
        const total = entries.reduce((s,e)=>s+e[1],0);
        entries.forEach(([cat,val]) => {
          const row = el('div',{style:'display:flex;align-items:center;gap:6px;justify-content:space-between'});
          const left = el('span',{style:'display:flex;align-items:center;gap:6px'});
          left.appendChild(el('span',{style:`width:8px;height:8px;border-radius:50%;background:${CAT_COLORS[cat]};flex-shrink:0`}));
          left.appendChild(el('span',{style:'color:var(--ink2)'},txt(cat)));
          row.appendChild(left);
          row.appendChild(el('span',{style:'font-weight:500'},txt(`${sanitizePct(val/total*100)}%`)));
          leg.appendChild(row);
        });
      }
    } else {
      const leg = document.getElementById('donut-legend');
      if (leg) leg.appendChild(el('div',{style:'color:var(--ink3);font-size:13px'},txt('No expenses this month')));
    }
  }

  const tc = document.getElementById('trend-chart');
  if (tc) {
    const months=[], incomes=[], expenses=[];
    const now = new Date();
    for (let i=5; i>=0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const txs = state.transactions.filter(t=>t.date.startsWith(key));
      months.push(d.toLocaleString('default',{month:'short'}));
      incomes.push(Math.round(totalIncome(txs)));
      expenses.push(Math.round(totalExpense(txs)));
    }
    new Chart(tc,{
      type:'bar',
      data:{labels:months,datasets:[
        {label:'Income',data:incomes,backgroundColor:'#16a34a88',borderColor:'#16a34a',borderWidth:1.5,borderRadius:4},
        {label:'Expenses',data:expenses,backgroundColor:'#dc262688',borderColor:'#dc2626',borderWidth:1.5,borderRadius:4}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
        scales:{y:{ticks:{callback:v=>'$'+Math.round(v).toLocaleString(),color:'#9898b8',font:{size:11}},grid:{color:'rgba(150,140,200,0.1)'}},x:{ticks:{color:'#9898b8',font:{size:11}},grid:{display:false}}}}
    });
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
loadState();
