// app.js — JS compartido por todas las páginas del panel

// ── Sidebar mobile ────────────────────────────────────────
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebar-overlay').classList.toggle('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}

// ── Clock ─────────────────────────────────────────────────
function startClock() {
  const el = document.getElementById('topbar-time');
  if (!el) return;
  const tick = () => el.textContent = new Date().toLocaleTimeString('es-AR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  tick();
  setInterval(tick, 1000);
}

// ── Toast ─────────────────────────────────────────────────
const TOAST_ICONS = { lime:'✓', red:'⚠', amber:'↻', blue:'ℹ' };

function toast(title, sub = '', type = 'lime') {
  const wrap = document.getElementById('toasts');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `
    <span class="toast-icon">${TOAST_ICONS[type] || '•'}</span>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      ${sub ? `<div class="toast-sub">${sub}</div>` : ''}
    </div>
    <button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>`;
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(20px)'; t.style.transition='all 0.3s'; setTimeout(()=>t.remove(), 300); }, 3500);
}

// ── Logout ────────────────────────────────────────────────
function confirmLogout() {
  if (confirm('¿Cerrar sesión?')) {
    localStorage.removeItem('orbitx_token');
    localStorage.removeItem('orbitx_user');
    window.location.href = '/logout';
  }
}

// ── Modal helpers ─────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.add('open');
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) m.classList.remove('open');
}
// Cerrar modal clickando backdrop
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-backdrop')) {
    e.target.classList.remove('open');
  }
});

// ── Alert helpers ─────────────────────────────────────────
function showAlert(id, msg, type = 'error') {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.className = `alert ${type} show`;
}
function hideAlert(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
}

// ── Formato de fechas ─────────────────────────────────────
function fmtDate(ts) {
  if (!ts) return '–';
  return new Date(ts).toLocaleString('es-AR', {
    day:'2-digit', month:'2-digit', year:'2-digit',
    hour:'2-digit', minute:'2-digit'
  });
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  startClock();

  // Cerrar sidebar al hacer click en nav link (mobile)
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', closeSidebar);
  });
});
