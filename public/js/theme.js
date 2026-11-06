// Light or dark theme. Runs in the page head so the right colours show before the
// page paints. The choice is remembered on this device; with no choice made it
// follows the phone or computer setting.
(function () {
  var KEY = 'theme';
  var root = document.documentElement;
  var colours = { light: '#231a33', dark: '#140f1f' };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'dark' || v === 'light' ? v : null;
    } catch (e) {
      return null;
    }
  }
  function system() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  function apply(theme) {
    root.setAttribute('data-theme', theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', colours[theme]);
    var btn = document.querySelector('[data-theme-toggle]');
    if (btn) {
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    }
  }

  apply(stored() || system());

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.querySelector('[data-theme-toggle]');
    apply(root.getAttribute('data-theme'));
    if (btn) {
      btn.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try {
          localStorage.setItem(KEY, next);
        } catch (e) {
          /* the choice just lasts for this visit */
        }
        apply(next);
      });
    }
  });

  if (window.matchMedia) {
    var query = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (!stored()) apply(system());
    };
    if (query.addEventListener) query.addEventListener('change', onChange);
  }
})();
