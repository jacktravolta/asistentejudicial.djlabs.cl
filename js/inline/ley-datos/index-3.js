    (function () {
      try {
        var api = (typeof window.__API_BASE__ === 'string') ? window.__API_BASE__.trim().replace(/\/+$/, '') : '';
        var heart = encodeURIComponent(localStorage.getItem('heart_id') || 'ley_datos_21719');
        fetch(api + '/ui/theme?heart=' + heart, { credentials: 'omit' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var d = j && j.data ? j.data : null;
            if (!d) return;
            var root = document.documentElement;
            if (typeof d.skin === 'string' && d.skin !== '') root.dataset.skin = d.skin;
            if (typeof d.tema === 'string' && d.tema !== ''
                && !localStorage.getItem('aj:tema')) root.dataset.tema = d.tema;
          })
          .catch(function () { /* fail gentle: the markup defaults stay */ });
      } catch (error) { /* fail gentle: the markup defaults stay */ }
    })();
  