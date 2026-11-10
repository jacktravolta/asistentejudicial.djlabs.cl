    (function () {
      var tl = document.getElementById('tab-login');
      var tr = document.getElementById('tab-register');
      var lf = document.getElementById('login-form');
      var rf = document.getElementById('register-form');
      if (!tl || !tr || !lf || !rf) return;
      function activate(on, off, onTab, offTab) {
        on.classList.remove('hidden');
        off.classList.add('hidden');
        onTab.setAttribute('aria-selected', 'true');
        offTab.setAttribute('aria-selected', 'false');
        onTab.classList.add('bg-white', 'text-brand-700', 'shadow-sm');
        onTab.classList.remove('text-slate-500');
        offTab.classList.remove('bg-white', 'text-brand-700', 'shadow-sm');
        offTab.classList.add('text-slate-500');
      }
      tl.addEventListener('click', function () { activate(lf, rf, tl, tr); });
      tr.addEventListener('click', function () { activate(rf, lf, tr, tl); });
      // Deep link support: /#register opens the register tab
      if (location.hash === '#register') { activate(rf, lf, tr, tl); }
    })();
  