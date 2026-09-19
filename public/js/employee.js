'use strict';

const state = {
  user: null,
  lookups: { projects: [], activities: [], standardHoursPerDay: 8, maxHoursPerDay: 16 },
  date: todayIso(),
  dayEntries: [],
  daySubmitted: false,
  editingId: null,
};

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

const VIEW_LOADERS = {
  log: loadDay,
  timesheet: loadTimesheet,
  overview: loadOverview,
  account: renderProfile,
};

function showView(name) {
  $$('.topbar nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  location.hash = name;
  VIEW_LOADERS[name]?.();
}

$$('.topbar nav button').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

$('#logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sign out regardless */ }
  location.href = '/login.html';
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  const [{ user }, lookups] = await Promise.all([api('/api/auth/me'), api('/api/lookups')]);
  state.user = user;
  state.lookups = lookups;
  setCurrency(lookups.currency);
  state.date = lookups.today;

  $('#who-name').textContent = user.name;
  $('#who-meta').textContent = `${user.employeeCode}${user.department ? ' · ' + user.department : ''}`;
  $('#must-reset').hidden = !user.mustReset;

  $('#project').innerHTML =
    '<option value="">Select a project…</option>' +
    lookups.projects
      .map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`)
      .join('');

  $('#activity').innerHTML =
    '<option value="">Select an activity…</option>' +
    lookups.activities.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');

  const dateInput = $('#entry-date');
  dateInput.value = state.date;
  dateInput.max = lookups.today;

  $('#ts-to').value = lookups.today;
  $('#ts-from').value = addDays(lookups.today, -29);

  const initial = location.hash.slice(1);
  showView(VIEW_LOADERS[initial] ? initial : 'log');
}

/* ------------------------------------------------------------------ */
/* Log time                                                            */
/* ------------------------------------------------------------------ */

function setDate(iso) {
  if (iso > state.lookups.today) {
    toast('You cannot log time against a future date.', 'error');
    return;
  }
  state.date = iso;
  $('#entry-date').value = iso;
  cancelEdit();
  loadDay();
}

$('#entry-date').addEventListener('change', (e) => setDate(e.target.value));
$('#day-prev').addEventListener('click', () => setDate(addDays(state.date, -1)));
$('#day-next').addEventListener('click', () => setDate(addDays(state.date, 1)));
$('#day-today').addEventListener('click', () => setDate(state.lookups.today));

async function loadDay() {
  $('#day-heading').textContent = prettyDate(state.date);
  $('#form-date-label').textContent = prettyDate(state.date);

  try {
    const data = await api(`/api/entries?from=${state.date}&to=${state.date}`);
    state.dayEntries = data.entries;
    state.daySubmitted = data.entries.length > 0 && data.entries.every((e) => e.status === 'submitted');
    renderDay();
  } catch (err) {
    toastError(err);
  }
}

function renderDay() {
  const entries = state.dayEntries;
  const total = entries.reduce((s, e) => s + e.hours, 0);
  const standard = state.lookups.standardHoursPerDay;

  // Meter
  const pct = Math.min(100, Math.round((total / standard) * 100));
  const fill = $('#day-fill');
  fill.style.width = `${pct}%`;
  fill.className = 'fill' + (total > standard ? ' over' : total >= standard ? ' full' : '');
  $('#day-readout').textContent = `${total.toFixed(2)} / ${standard} h`;

  // Submit control
  const submitBtn = $('#submit-day');
  submitBtn.hidden = false;
  submitBtn.disabled = state.daySubmitted || entries.length === 0;
  submitBtn.textContent = state.daySubmitted ? 'Submitted' : 'Submit day';
  $('#day-status').innerHTML = state.daySubmitted
    ? '<span class="badge submitted">Submitted &amp; locked</span>'
    : entries.length
      ? '<span class="badge draft">Draft</span>'
      : '';

  // Rows
  const tbody = $('#day-rows');
  if (entries.length === 0) {
    tbody.innerHTML = emptyRow(5, 'No entries yet', 'Use the form on the left to log your first task for this day.');
    return;
  }

  tbody.innerHTML = entries
    .map(
      (e) => `
      <tr>
        <td>
          <div><strong>${esc(e.project_code)}</strong></div>
          <div class="muted">${esc(e.project_name)}</div>
        </td>
        <td>${esc(e.activity_name)}</td>
        <td style="max-width:360px">
          ${esc(e.description)}
          ${e.ticket_ref ? `<div class="muted code">${esc(e.ticket_ref)}</div>` : ''}
        </td>
        <td class="num"><strong>${e.hours.toFixed(2)}</strong></td>
        <td class="actions">
          ${
            e.status === 'submitted'
              ? '<span class="badge submitted">Locked</span>'
              : `<button class="btn ghost sm" data-edit="${e.id}">Edit</button>
                 <button class="btn ghost danger sm" data-delete="${e.id}">Delete</button>`
          }
        </td>
      </tr>`
    )
    .join('');

  $$('[data-edit]', tbody).forEach((b) =>
    b.addEventListener('click', () => startEdit(Number(b.dataset.edit)))
  );
  $$('[data-delete]', tbody).forEach((b) =>
    b.addEventListener('click', () => removeEntry(Number(b.dataset.delete)))
  );
}

function startEdit(id) {
  const entry = state.dayEntries.find((e) => e.id === id);
  if (!entry) return;
  state.editingId = id;

  $('#entry-id').value = id;
  $('#project').value = entry.project_id;
  $('#activity').value = entry.activity_id;
  $('#hours').value = entry.hours;
  $('#ticket').value = entry.ticket_ref;
  $('#description').value = entry.description;

  $('#form-title').textContent = 'Edit entry';
  $('#entry-save').textContent = 'Save changes';
  $('#entry-cancel').hidden = false;
  $('#project').focus();
}

function cancelEdit() {
  state.editingId = null;
  $('#entry-form').reset();
  $('#entry-id').value = '';
  $('#form-title').textContent = 'Add an entry';
  $('#entry-save').textContent = 'Add entry';
  $('#entry-cancel').hidden = true;
}

$('#entry-cancel').addEventListener('click', cancelEdit);

$('#entry-form').addEventListener('submit', async (event) => {
  event.preventDefault();

  const body = {
    entryDate: state.date,
    projectId: Number($('#project').value),
    activityId: Number($('#activity').value),
    hours: Number($('#hours').value),
    ticketRef: $('#ticket').value,
    description: $('#description').value,
  };

  if (!body.projectId) return toast('Please choose a project.', 'error');
  if (!body.activityId) return toast('Please choose an activity.', 'error');

  await withBusy($('#entry-save'), async () => {
    try {
      if (state.editingId) {
        await api(`/api/entries/${state.editingId}`, { method: 'PUT', body });
        toast('Entry updated.', 'success');
      } else {
        await api('/api/entries', { method: 'POST', body });
        toast('Entry added.', 'success');
      }
      cancelEdit();
      await loadDay();
    } catch (err) {
      toastError(err);
    }
  });
});

async function removeEntry(id) {
  if (!confirm('Delete this entry? This cannot be undone.')) return;
  try {
    await api(`/api/entries/${id}`, { method: 'DELETE' });
    if (state.editingId === id) cancelEdit();
    toast('Entry deleted.', 'success');
    await loadDay();
  } catch (err) {
    toastError(err);
  }
}

$('#submit-day').addEventListener('click', async () => {
  const total = state.dayEntries.reduce((s, e) => s + e.hours, 0);
  const standard = state.lookups.standardHoursPerDay;
  const warning =
    total < standard
      ? `You have logged ${total.toFixed(2)} hours, below the usual ${standard}. `
      : '';
  if (!confirm(`${warning}Submit ${prettyDate(state.date)}? Entries become read-only.`)) return;

  await withBusy($('#submit-day'), async () => {
    try {
      await api('/api/entries/submit', { method: 'POST', body: { date: state.date } });
      toast('Day submitted.', 'success');
      await loadDay();
    } catch (err) {
      toastError(err);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Timesheet                                                           */
/* ------------------------------------------------------------------ */

$('#ts-preset').addEventListener('change', (e) => {
  const today = state.lookups.today;
  const v = e.target.value;
  if (v === 'month') {
    $('#ts-from').value = startOfMonth(today);
    $('#ts-to').value = today;
  } else if (v === 'prevmonth') {
    const first = startOfMonth(today);
    const lastDayPrev = addDays(first, -1);
    $('#ts-from').value = startOfMonth(lastDayPrev);
    $('#ts-to').value = lastDayPrev;
  } else {
    $('#ts-from').value = addDays(today, -(Number(v) - 1));
    $('#ts-to').value = today;
  }
  loadTimesheet();
});

$('#ts-apply').addEventListener('click', loadTimesheet);

async function loadTimesheet() {
  const from = $('#ts-from').value;
  const to = $('#ts-to').value;
  if (!from || !to) return;

  try {
    const data = await api(`/api/entries?from=${from}&to=${to}`);
    const days = data.days.length;
    const submitted = data.days.filter((d) => d.submitted).length;
    const avg = days ? data.totalHours / days : 0;

    $('#ts-stats').innerHTML = [
      { label: 'Total hours', value: data.totalHours.toFixed(2), note: `${data.entries.length} entries` },
      { label: 'Days logged', value: String(days), note: `${submitted} submitted` },
      { label: 'Average / logged day', value: avg.toFixed(2), note: 'hours' },
    ]
      .map(
        (s) =>
          `<div class="stat"><div class="label">${esc(s.label)}</div><div class="value">${esc(
            s.value
          )}</div><div class="note">${esc(s.note)}</div></div>`
      )
      .join('');

    $('#ts-count').textContent = `${prettyDate(from)} — ${prettyDate(to)}`;

    const tbody = $('#ts-rows');
    if (data.entries.length === 0) {
      tbody.innerHTML = emptyRow(7, 'Nothing logged in this period', 'Try a wider date range.');
      $('#ts-foot').innerHTML = '';
      return;
    }

    tbody.innerHTML = data.entries
      .map(
        (e) => `
        <tr>
          <td style="white-space:nowrap">${esc(shortDate(e.entry_date))}</td>
          <td><strong>${esc(e.project_code)}</strong><div class="muted">${esc(e.project_name)}</div></td>
          <td>${esc(e.activity_name)}</td>
          <td style="max-width:420px">${esc(e.description)}${
            e.ticket_ref ? `<div class="muted code">${esc(e.ticket_ref)}</div>` : ''
          }</td>
          <td class="num">${e.hours.toFixed(2)}</td>
          <td><span class="badge ${e.status}">${e.status === 'submitted' ? 'Submitted' : 'Draft'}</span></td>
          <td class="actions">${
            e.status === 'draft'
              ? `<button class="btn ghost sm" data-goto="${esc(e.entry_date)}">Open day</button>`
              : ''
          }</td>
        </tr>`
      )
      .join('');

    $('#ts-foot').innerHTML = `<tr><td colspan="4">Total</td><td class="num">${data.totalHours.toFixed(
      2
    )}</td><td colspan="2"></td></tr>`;

    $$('[data-goto]', tbody).forEach((b) =>
      b.addEventListener('click', () => {
        showView('log');
        setDate(b.dataset.goto);
      })
    );
  } catch (err) {
    toastError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

async function loadOverview() {
  try {
    const d = await api('/api/summary/me');
    const standard = d.standardHoursPerDay;

    const cards = [
      {
        label: 'Today',
        value: d.today.hours.toFixed(2),
        note: `${d.today.entries} entries`,
        cls: d.today.hours >= standard ? 'good' : d.today.hours > 0 ? 'warn' : 'bad',
      },
      { label: 'Last 7 days', value: d.week.hours.toFixed(2), note: `${d.week.entries} entries` },
      { label: 'This month', value: d.month.hours.toFixed(2), note: `${d.month.entries} entries` },
      {
        label: 'Missing weekdays',
        value: String(d.missingDays.length),
        note: 'in the last 7 days',
        cls: d.missingDays.length === 0 ? 'good' : 'warn',
      },
    ];

    $('#ov-stats').innerHTML = cards
      .map(
        (s) =>
          `<div class="stat ${s.cls || ''}"><div class="label">${esc(s.label)}</div><div class="value">${esc(
            s.value
          )}</div><div class="note">${esc(s.note)}</div></div>`
      )
      .join('');

    renderBars($('#ov-projects'), d.byProject, { labelKey: 'code', valueKey: 'hours' });

    $('#ov-missing').innerHTML = d.missingDays.length
      ? d.missingDays
          .map(
            (day) =>
              `<div class="bar-row"><div class="bar-label">${esc(
                prettyDate(day)
              )}</div><div class="bar-value"><button class="btn ghost sm" data-fill="${esc(
                day
              )}">Log now</button></div></div>`
          )
          .join('')
      : '<div class="empty"><strong>All caught up</strong>Every weekday in the last week has entries.</div>';

    $$('[data-fill]').forEach((b) =>
      b.addEventListener('click', () => {
        showView('log');
        setDate(b.dataset.fill);
      })
    );
  } catch (err) {
    toastError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Account                                                             */
/* ------------------------------------------------------------------ */

function renderProfile() {
  const u = state.user;
  const rows = [
    ['Name', u.name],
    ['Employee code', u.employeeCode],
    ['Email', u.email],
    ['Department', u.department || '—'],
    ['Role', u.role === 'admin' ? 'Administrator' : 'Employee'],
  ];
  $('#profile-table').innerHTML = rows
    .map(([k, v]) => `<tr><td class="muted" style="width:40%">${esc(k)}</td><td><strong>${esc(v)}</strong></td></tr>`)
    .join('');
}

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = $('#pw-new').value;
  if (next !== $('#pw-confirm').value) return toast('New passwords do not match.', 'error');

  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: $('#pw-current').value, newPassword: next },
    });
    $('#password-form').reset();
    $('#must-reset').hidden = true;
    state.user.mustReset = false;
    toast('Password updated.', 'success');
  } catch (err) {
    toastError(err);
  }
});

boot().catch((err) => {
  console.error(err);
  toast('Could not load the app. Please refresh.', 'error');
});
