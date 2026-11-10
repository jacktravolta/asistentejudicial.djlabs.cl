    // Apply the saved theme before first paint to avoid a flash.
    (function () {
      try {
        var params = new URLSearchParams(window.location.search);
        var tema = params.get('tema');
        var skin = params.get('skin');
        if (tema === 'dia' || tema === 'noche') localStorage.setItem('aj:tema', tema);
        if (skin === 'teal' || skin === 'indigo') localStorage.setItem('aj:skin', skin);
        var storedTema = localStorage.getItem('aj:tema') || 'dia';
        var storedSkin = localStorage.getItem('aj:skin') || 'teal';
        document.documentElement.setAttribute('data-tema', storedTema);
        document.documentElement.setAttribute('data-skin', storedSkin);
      } catch (error) {}
    })();
  