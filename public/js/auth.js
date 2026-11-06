import { api, $, $$, initChrome, safeNext } from './app.js';

const form = $('form[data-auth-form]');
const mode = form.dataset.authForm; // 'login' or 'register'
const next = new URLSearchParams(location.search).get('next');

// Keep the destination when moving between log in and create account.
const switchLink = $('[data-switch]');
if (switchLink && next) switchLink.href += `?next=${encodeURIComponent(safeNext(next))}`;

initChrome().then((user) => {
  if (user) location.replace(user.role === 'admin' && !next ? '/admin.html' : safeNext(next));
});

const showPassword = $('#show-pw');
const passwordInput = $('input[name="password"]', form);
if (showPassword) {
  showPassword.addEventListener('change', () => {
    passwordInput.type = showPassword.checked ? 'text' : 'password';
  });
}

function clearErrors() {
  $('[data-form-error]', form).textContent = '';
  $$('[data-error-for]', form).forEach((el) => {
    el.textContent = '';
  });
  $$('.input', form).forEach((el) => el.removeAttribute('aria-invalid'));
}

function showErrors(err) {
  $('[data-form-error]', form).textContent = err.message;
  let first = null;
  for (const [field, message] of Object.entries(err.fields || {})) {
    const slot = $(`[data-error-for="${field}"]`, form);
    const input = $(`[name="${field}"]`, form);
    if (slot) slot.textContent = message;
    if (input) {
      input.setAttribute('aria-invalid', 'true');
      first = first || input;
    }
  }
  if (first) first.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearErrors();

  const button = $('button[type="submit"]', form);
  const label = button.textContent;
  button.disabled = true;
  button.textContent = mode === 'login' ? 'Logging in' : 'Creating account';

  try {
    const { user } = await api(`/auth/${mode}`, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
    location.assign(user.role === 'admin' && !next ? '/admin.html' : safeNext(next));
  } catch (err) {
    showErrors(err);
    button.disabled = false;
    button.textContent = label;
  }
});
