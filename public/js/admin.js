'use strict';

const state = {
  user: null,
  users: [],
  projects: [],
  activities: [],
  currency: 'INR',
};

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

const VIEW_LOADERS = {
  dashboard: loadDashboard,
  entries: loadEntries,
  projects: loadProjects,
  people: loadUsers,
  activities: loadActivities,
};

function showView(name) {
  $$('.topbar nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  location.hash = name;
  VIEW_LOADERS[name]?.();
}

$$('.topbar nav button').forEach((btn) =>
  btn.addEventListener('click', () => showView(btn.dataset.view))
);

$('#logout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* sign out regardless */ }
  location.href = '/login.html';
});

// Every modal's Cancel button just closes its dialog.
$$('[data-close]').forEach((b) =>
  b.addEventListener('click', () => b.closest('dialog').close())
);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  const { user } = await api('/api/auth/me');
  state.user = user;
  $('#who-name').textContent = user.name;
  $('#who-meta').textContent = 'Administrator';

  const today = todayIso();
  $('#dash-from').value = startOfMonth(today);
  $('#dash-to').value = today;
  $('#f-from').value = startOfMonth(today);
  $('#f-to').value = today;

  await Promise.all([refreshUserList(), refreshProjectList()]);

  const initial = location.hash.slice(1);
  showView(VIEW_LOADERS[initial] ? initial : 'dashboard');
}

async function refreshUserList() {
  const { users } = await api('/api/admin/users');
  state.users = users;
  $('#f-user').innerHTML =
    '<option value="">All employees</option>' +
    users.map((u) => `<option value="${u.id}">${esc(u.employee_code)} — ${esc(u.name)}</option>`).join('');
}

async function refreshProjectList() {
  const { projects } = await api('/api/admin/projects');
  state.projects = projects;
  $('#f-project').innerHTML =
    '<option value="">All projects</option>' +
    projects.map((p) => `<option value="${p.id}">${esc(p.code)} — ${esc(p.name)}</option>`).join('');
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

$('#dash-preset').addEventListener('change', (e) => {
  const today = todayIso();
  const v = e.target.value;
  if (v === 'month') {
    $('#dash-from').value = startOfMonth(today);
    $('#dash-to').value = today;
  } else if (v === 'prevmonth') {
    const lastDayPrev = addDays(startOfMonth(today), -1);
    $('#dash-from').value = startOfMonth(lastDayPrev);
    $('#dash-to').value = lastDayPrev;
  } else if (v === 'year') {
    $('#dash-from').value = `${today.slice(0, 4)}-01-01`;
    $('#dash-to').value = today;
  } else {
    $('#dash-from').value = addDays(today, -(Number(v) - 1));
    $('#dash-to').value = today;
  }
  loadDashboard();
});

$('#dash-apply').addEventListener('click', loadDashboard);

async function loadDashboard() {
  const from = $('#dash-from').value;
  const to = $('#dash-to').value;
  if (!from || !to) return;

  try {
    const d = await api(`/api/admin/dashboard?from=${from}&to=${to}`);
    state.currency = d.currency;
    setCurrency(d.currency);

    const nonBillableHours = d.totals.hours - d.billable.hours;
    const billablePct = d.totals.hours ? Math.round((d.billable.hours / d.totals.hours) * 100) : 0;

    $('#dash-stats').innerHTML = [
      { label: 'Total hours', value: hrs(d.totals.hours).replace(' h', ''), note: `${num(d.totals.entries)} entries` },
      { label: 'Total cost', value: money(d.totals.cost), note: `${num(d.totals.people)} people` },
      { label: 'Billable hours', value: hrs(d.billable.hours).replace(' h', ''), note: `${billablePct}% of total`, cls: billablePct >= 70 ? 'good' : 'warn' },
      { label: 'Non-billable', value: hrs(nonBillableHours).replace(' h', ''), note: money(d.totals.cost - d.billable.cost) },
    ]
      .map(
        (s) =>
          `<div class="stat ${s.cls || ''}"><div class="label">${esc(s.label)}</div><div class="value">${esc(
            s.value
          )}</div><div class="note">${esc(s.note)}</div></div>`
      )
      .join('');

    renderExcelStatus(d.excel);

    $('#dash-cost-note').textContent = `${prettyDate(from)} — ${prettyDate(to)}`;
    renderBars($('#dash-project-bars'), d.byProject.slice(0, 10), {
      labelKey: 'code',
      valueKey: 'cost',
      format: money,
    });
    renderBars($('#dash-activity-bars'), d.byActivity.slice(0, 12), {
      labelKey: 'activity',
      valueKey: 'hours',
      alt: true,
    });

    // Project table
    const pRows = $('#dash-project-rows');
    pRows.innerHTML = d.byProject.length
      ? d.byProject
          .map(
            (p) => `
            <tr>
              <td><strong class="code">${esc(p.code)}</strong></td>
              <td>${esc(p.name)}</td>
              <td class="muted">${esc(p.client || '—')}</td>
              <td><span class="badge ${p.is_billable ? 'billable' : 'nonbillable'}">${
                p.is_billable ? 'Billable' : 'Internal'
              }</span></td>
              <td class="num">${num(p.people)}</td>
              <td class="num">${p.hours.toFixed(2)}</td>
              <td class="num"><strong>${esc(money(p.cost))}</strong></td>
            </tr>`
          )
          .join('')
      : emptyRow(7, 'No time logged in this period');

    $('#dash-project-foot').innerHTML = d.byProject.length
      ? `<tr><td colspan="5">Total</td><td class="num">${d.totals.hours.toFixed(2)}</td><td class="num">${esc(
          money(d.totals.cost)
        )}</td></tr>`
      : '';

    // Employee table
    $('#dash-employee-rows').innerHTML = d.byEmployee.length
      ? d.byEmployee
          .map(
            (u) => `
            <tr>
              <td><strong>${esc(u.name)}</strong><div class="muted code">${esc(u.employee_code)}${
                u.department ? ' · ' + esc(u.department) : ''
              }</div></td>
              <td class="num">${num(u.days_logged)}</td>
              <td class="num">${u.hours.toFixed(2)}</td>
              <td class="num">${esc(money(u.cost))}</td>
            </tr>`
          )
          .join('')
      : emptyRow(4, 'No time logged in this period');

    $('#dash-missing').innerHTML = d.notSubmitted.length
      ? d.notSubmitted
          .map(
            (u) =>
              `<div class="bar-row"><div class="bar-label">${esc(u.name)}</div><div class="bar-value code">${esc(
                u.employee_code
              )}</div></div>`
          )
          .join('')
      : '<div class="empty"><strong>Everyone has logged time</strong>All active employees have entries in this period.</div>';
  } catch (err) {
    toastError(err);
  }
}

function renderExcelStatus(status) {
  const warn = $('#excel-warning');
  if (status.lastError) {
    warn.textContent = `Excel sync problem: ${status.lastError}`;
    warn.hidden = false;
  } else {
    warn.hidden = true;
  }
  $('#excel-status').textContent = status.lastSyncedAt
    ? `Last written ${new Date(status.lastSyncedAt).toLocaleString()}`
    : 'Not written yet';
}

$('#excel-sync').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    try {
      const { status } = await api('/api/admin/excel/sync', { method: 'POST' });
      renderExcelStatus(status);
      toast('Workbook re-synced.', 'success');
    } catch (err) {
      toastError(err);
      loadDashboard();
    }
  })
);

$('#excel-backup').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    try {
      const { file } = await api('/api/admin/excel/backup', { method: 'POST' });
      toast(`Backup written: ${file}`, 'success', 7000);
    } catch (err) {
      toastError(err);
    }
  })
);

/* ------------------------------------------------------------------ */
/* All entries                                                         */
/* ------------------------------------------------------------------ */

$('#f-apply').addEventListener('click', loadEntries);

async function loadEntries() {
  const params = new URLSearchParams({ from: $('#f-from').value, to: $('#f-to').value });
  if ($('#f-user').value) params.set('userId', $('#f-user').value);
  if ($('#f-project').value) params.set('projectId', $('#f-project').value);
  if ($('#f-status').value) params.set('status', $('#f-status').value);

  try {
    const d = await api(`/api/admin/entries?${params}`);
    setCurrency(state.currency);

    $('#entries-summary').textContent =
      `${num(d.entries.length)} entries · ${d.totalHours.toFixed(2)} h · ${money(d.totalCost)}` +
      (d.truncated ? ' (showing first 2000 — narrow the range)' : '');

    const tbody = $('#entries-rows');
    if (!d.entries.length) {
      tbody.innerHTML = emptyRow(9, 'No entries match these filters');
      $('#entries-foot').innerHTML = '';
      return;
    }

    tbody.innerHTML = d.entries
      .map(
        (e) => `
        <tr>
          <td style="white-space:nowrap">${esc(shortDate(e.entry_date))}</td>
          <td><strong>${esc(e.employee_name)}</strong><div class="muted code">${esc(e.employee_code)}</div></td>
          <td><span class="code">${esc(e.project_code)}</span></td>
          <td>${esc(e.activity_name)}</td>
          <td style="max-width:340px">${esc(e.description)}${
            e.ticket_ref ? `<div class="muted code">${esc(e.ticket_ref)}</div>` : ''
          }</td>
          <td class="num">${e.hours.toFixed(2)}</td>
          <td class="num">${esc(money(e.cost))}</td>
          <td><span class="badge ${e.status}">${e.status === 'submitted' ? 'Submitted' : 'Draft'}</span></td>
          <td class="actions">
            ${
              e.status === 'submitted'
                ? `<button class="btn ghost sm" data-reopen="${e.user_id}" data-date="${esc(
                    e.entry_date
                  )}">Reopen day</button>`
                : ''
            }
            <button class="btn ghost danger sm" data-del="${e.id}">Delete</button>
          </td>
        </tr>`
      )
      .join('');

    $('#entries-foot').innerHTML = `<tr><td colspan="5">Total</td><td class="num">${d.totalHours.toFixed(
      2
    )}</td><td class="num">${esc(money(d.totalCost))}</td><td colspan="2"></td></tr>`;

    $$('[data-reopen]', tbody).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(`Reopen ${prettyDate(b.dataset.date)} for editing by this employee?`)) return;
        try {
          await api('/api/admin/entries/reopen', {
            method: 'POST',
            body: { userId: Number(b.dataset.reopen), date: b.dataset.date },
          });
          toast('Day reopened.', 'success');
          loadEntries();
        } catch (err) {
          toastError(err);
        }
      })
    );

    $$('[data-del]', tbody).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm('Permanently delete this entry?')) return;
        try {
          await api(`/api/admin/entries/${b.dataset.del}`, { method: 'DELETE' });
          toast('Entry deleted.', 'success');
          loadEntries();
        } catch (err) {
          toastError(err);
        }
      })
    );
  } catch (err) {
    toastError(err);
  }
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

async function loadProjects() {
  try {
    await refreshProjectList();
    setCurrency(state.currency);

    $('#project-rows').innerHTML = state.projects.length
      ? state.projects
          .map(
            (p) => `
            <tr>
              <td><strong class="code">${esc(p.code)}</strong></td>
              <td>${esc(p.name)}</td>
              <td class="muted">${esc(p.client || '—')}</td>
              <td><span class="badge ${p.is_billable ? 'billable' : 'nonbillable'}">${
                p.is_billable ? 'Billable' : 'Internal'
              }</span></td>
              <td>${p.is_active ? '<span class="badge submitted">Open</span>' : '<span class="badge inactive">Closed</span>'}</td>
              <td class="num">${p.total_hours.toFixed(2)}</td>
              <td class="num">${esc(money(p.total_cost))}</td>
              <td class="actions"><button class="btn ghost sm" data-edit-project="${p.id}">Edit</button></td>
            </tr>`
          )
          .join('')
      : emptyRow(8, 'No projects yet', 'Create one so employees have something to book time against.');

    $$('[data-edit-project]').forEach((b) =>
      b.addEventListener('click', () => openProjectModal(Number(b.dataset.editProject)))
    );
  } catch (err) {
    toastError(err);
  }
}

function openProjectModal(id = null) {
  const p = id ? state.projects.find((x) => x.id === id) : null;
  $('#project-modal-title').textContent = p ? `Edit ${p.code}` : 'New project';
  $('#pm-id').value = p ? p.id : '';
  $('#pm-code').value = p ? p.code : '';
  $('#pm-code').disabled = !!p;
  $('#pm-name').value = p ? p.name : '';
  $('#pm-client').value = p ? p.client : '';
  $('#pm-billable').checked = p ? !!p.is_billable : true;
  $('#pm-active').checked = p ? !!p.is_active : true;
  $('#project-modal').showModal();
}

$('#new-project').addEventListener('click', () => openProjectModal());

$('#pm-save').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const id = $('#pm-id').value;
    const body = {
      code: $('#pm-code').value,
      name: $('#pm-name').value,
      client: $('#pm-client').value,
      isBillable: $('#pm-billable').checked,
      isActive: $('#pm-active').checked,
    };
    if (!body.code.trim() || !body.name.trim()) return toast('Code and name are required.', 'error');

    try {
      if (id) await api(`/api/admin/projects/${id}`, { method: 'PUT', body });
      else await api('/api/admin/projects', { method: 'POST', body });
      $('#project-modal').close();
      toast(id ? 'Project updated.' : 'Project created.', 'success');
      loadProjects();
    } catch (err) {
      toastError(err);
    }
  })
);

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

async function loadUsers() {
  try {
    await refreshUserList();
    setCurrency(state.currency);

    $('#user-rows').innerHTML = state.users
      .map(
        (u) => `
        <tr>
          <td><strong class="code">${esc(u.employee_code)}</strong></td>
          <td>${esc(u.name)}${u.must_reset ? ' <span class="badge draft">Temp password</span>' : ''}</td>
          <td class="muted">${esc(u.email)}</td>
          <td class="muted">${esc(u.department || '—')}</td>
          <td>${u.role === 'admin' ? '<span class="badge admin">Admin</span>' : 'Employee'}</td>
          <td class="num">${esc(money(u.hourly_rate))}</td>
          <td class="num">${u.total_hours.toFixed(2)}</td>
          <td>${u.is_active ? '<span class="badge submitted">Active</span>' : '<span class="badge inactive">Inactive</span>'}</td>
          <td class="actions">
            <button class="btn ghost sm" data-edit-user="${u.id}">Edit</button>
            <button class="btn ghost danger sm" data-reset-user="${u.id}">Reset password</button>
          </td>
        </tr>`
      )
      .join('');

    $$('[data-edit-user]').forEach((b) =>
      b.addEventListener('click', () => openUserModal(Number(b.dataset.editUser)))
    );
    $$('[data-reset-user]').forEach((b) =>
      b.addEventListener('click', () => openResetModal(Number(b.dataset.resetUser)))
    );
  } catch (err) {
    toastError(err);
  }
}

function openUserModal(id = null) {
  const u = id ? state.users.find((x) => x.id === id) : null;
  $('#user-modal-title').textContent = u ? `Edit ${u.name}` : 'Add person';
  $('#um-id').value = u ? u.id : '';
  $('#um-code').value = u ? u.employee_code : '';
  $('#um-code').disabled = !!u;
  $('#um-name').value = u ? u.name : '';
  $('#um-email').value = u ? u.email : '';
  $('#um-email').disabled = !!u;
  $('#um-dept').value = u ? u.department : '';
  $('#um-rate').value = u ? u.hourly_rate : 0;
  $('#um-role').value = u ? u.role : 'employee';
  $('#um-active').checked = u ? !!u.is_active : true;
  $('#um-password').value = '';
  $('#um-password-field').hidden = !!u;
  $('#user-modal').showModal();
}

$('#new-user').addEventListener('click', () => openUserModal());

$('#um-save').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const id = $('#um-id').value;
    const body = {
      employeeCode: $('#um-code').value,
      name: $('#um-name').value,
      email: $('#um-email').value,
      department: $('#um-dept').value,
      hourlyRate: Number($('#um-rate').value),
      role: $('#um-role').value,
      isActive: $('#um-active').checked,
      password: $('#um-password').value,
    };

    try {
      if (id) await api(`/api/admin/users/${id}`, { method: 'PUT', body });
      else await api('/api/admin/users', { method: 'POST', body });
      $('#user-modal').close();
      toast(id ? 'Person updated.' : 'Person added.', 'success');
      loadUsers();
    } catch (err) {
      toastError(err);
    }
  })
);

function openResetModal(id) {
  const u = state.users.find((x) => x.id === id);
  $('#rm-id').value = id;
  $('#rm-who').innerHTML = `Set a new temporary password for <strong>${esc(u.name)}</strong> (${esc(u.email)}).`;
  $('#rm-password').value = '';
  $('#reset-modal').showModal();
}

$('#rm-save').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    try {
      await api(`/api/admin/users/${$('#rm-id').value}/reset-password`, {
        method: 'POST',
        body: { password: $('#rm-password').value },
      });
      $('#reset-modal').close();
      toast('Password reset. Share the new password with them.', 'success');
      loadUsers();
    } catch (err) {
      toastError(err);
    }
  })
);

/* ------------------------------------------------------------------ */
/* Activities                                                          */
/* ------------------------------------------------------------------ */

async function loadActivities() {
  try {
    const { activities } = await api('/api/admin/activities');
    state.activities = activities;

    $('#activity-rows').innerHTML = activities
      .map(
        (a) => `
        <tr>
          <td><strong>${esc(a.name)}</strong></td>
          <td class="num">${num(a.uses)}</td>
          <td>${a.is_active ? '<span class="badge submitted">In use</span>' : '<span class="badge inactive">Retired</span>'}</td>
          <td class="actions"><button class="btn ghost sm" data-edit-activity="${a.id}">Edit</button></td>
        </tr>`
      )
      .join('');

    $$('[data-edit-activity]').forEach((b) =>
      b.addEventListener('click', () => openActivityModal(Number(b.dataset.editActivity)))
    );
  } catch (err) {
    toastError(err);
  }
}

function openActivityModal(id = null) {
  const a = id ? state.activities.find((x) => x.id === id) : null;
  $('#activity-modal-title').textContent = a ? 'Edit activity' : 'New activity';
  $('#am-id').value = a ? a.id : '';
  $('#am-name').value = a ? a.name : '';
  $('#am-active').checked = a ? !!a.is_active : true;
  $('#activity-modal').showModal();
}

$('#new-activity').addEventListener('click', () => openActivityModal());

$('#am-save').addEventListener('click', (e) =>
  withBusy(e.target, async () => {
    const id = $('#am-id').value;
    const body = { name: $('#am-name').value, isActive: $('#am-active').checked };
    if (!body.name.trim()) return toast('Activity name is required.', 'error');

    try {
      if (id) await api(`/api/admin/activities/${id}`, { method: 'PUT', body });
      else await api('/api/admin/activities', { method: 'POST', body });
      $('#activity-modal').close();
      toast(id ? 'Activity updated.' : 'Activity created.', 'success');
      loadActivities();
    } catch (err) {
      toastError(err);
    }
  })
);

boot().catch((err) => {
  console.error(err);
  toast('Could not load the admin console. Please refresh.', 'error');
});
