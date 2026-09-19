'use strict';

const form = $('#login-form');
const errorBox = $('#error');
const noticeBox = $('#notice');
const submitBtn = $('#submit');

if (new URLSearchParams(location.search).has('expired')) {
  noticeBox.textContent = 'Your session expired. Please sign in again.';
  noticeBox.hidden = false;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  noticeBox.hidden = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  try {
    const { user } = await api('/api/auth/login', {
      method: 'POST',
      body: { email: $('#email').value, password: $('#password').value },
    });
    location.href = user.role === 'admin' ? '/admin.html' : '/app.html';
  } catch (err) {
    showError(err.message);
    $('#password').value = '';
    $('#password').focus();
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});
