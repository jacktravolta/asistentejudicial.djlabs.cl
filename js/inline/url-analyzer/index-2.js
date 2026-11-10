    const heart = 'url-analyzer';
    localStorage.setItem('heart_id', heart);
    // Post-login destination: this heart's own panel.
    const APP_URL = './app.html';

    // Request a magic access link for the typed email. Shared by the login
    // button (empty password) and the recovery link. The router route expects
    // a JSON body and never returns a token: the magic link travels only by
    // email.
    async function requestMagicLink() {
      // Read the email AT CLICK TIME so the link goes to the address the
      // visitor actually typed.
      const email = document.getElementById('magic-link-email')?.value || 'test@test.com';
      const response = await fetch(window.API('/auth/magic-link'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ heart: heart, email: email, terms_accepted: true })
      });

      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success) {
        return (data.data && data.data.message) || 'Si el correo es válido, te enviaremos un enlace para iniciar sesión.';
      }

      const message = (data.error && data.error.message) || 'No pudimos enviar el enlace en este momento. Por favor inténtalo de nuevo en unos minutos.';
      throw new Error(message);
    }

    // POST /auth/login with the typed credentials. On success the backend
    // sets the httpOnly session cookies and the caller navigates to APP_URL.
    async function loginWithPassword(email, password) {
      const response = await fetch(window.API('/auth/login'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, heart: heart })
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.success) {
        const err = data.error;
        const message = typeof err === 'string' ? err : (err && err.message) || 'No pudimos iniciar sesión en este momento. Inténtalo de nuevo en unos minutos.';
        throw Object.assign(new Error(message), { status: response.status });
      }

      return data;
    }

    document.getElementById('loginBtn').addEventListener('click', async () => {
      const btn = document.getElementById('loginBtn');
      const originalText = btn.textContent;
      btn.disabled = true;
      let navigating = false;

      try {
        const email = document.getElementById('magic-link-email')?.value || 'test@test.com';
        const password = document.getElementById('login-password')?.value || '';

        if (password !== '') {
          btn.textContent = 'Entrando...';
          await loginWithPassword(email, password);
          navigating = true;
          window.location.assign(APP_URL);
          return;
        }

        btn.textContent = 'Enviando...';
        const message = await requestMagicLink();
        alert(message + ' Revisa tu bandeja de entrada: el enlace llega a tu correo.');
      } catch (error) {
        if (error.status === 401) {
          // Most existing accounts never set a password (magic-link only).
          alert(error.message + '\n\nSi nunca fijaste una contraseña, usa el enlace mágico: llega a tu correo y desde tu Perfil puedes dejarla guardada.');
        } else {
          alert(error.message);
        }
      } finally {
        if (!navigating) {
          btn.textContent = originalText;
          btn.disabled = false;
        }
      }
    });

    document.getElementById('recover-link').addEventListener('click', async () => {
      const link = document.getElementById('recover-link');
      const originalText = link.textContent;
      link.disabled = true;
      link.textContent = 'Enviando...';

      try {
        const message = await requestMagicLink();
        alert(message + '\n\nCon ese enlace puedes entrar sin necesidad de contraseña. Ya dentro, desde tu Perfil puedes fijar una contraseña nueva y dejarla guardada para la próxima vez.');
      } catch (error) {
        alert(error.message);
      } finally {
        link.textContent = originalText;
        link.disabled = false;
      }
    });
  