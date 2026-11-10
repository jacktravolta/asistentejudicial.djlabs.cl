// Auth module for Asistente Judicial
// Handles magic link authentication and session management

import { apiUrl } from '../api-base.js';

/**
 * Request a magic link for authentication
 * @param {string} email - User email
 * @param {HTMLElement} button - The button that triggered this (optional)
 */
async function requestMagicLink(email, button = null) {
    const formData = new FormData();
    formData.append('email', email);

    try {
        const response = await fetch(apiUrl('/auth/magic-link'), {
            method: 'POST',
            body: formData,
            headers: {
                'Accept': 'application/json',
            },
            credentials: 'include',
        });

        const data = await response.json();

        if (data.success) {
            // Show the magic link URL or instruct user to check email
            if (button) {
                button.textContent = 'Enviado';
                button.disabled = true;
            }
            showNotification('success', 'Magic link solicitado. Revisa tu email.');
            return true;
        } else {
            showNotification('error', data.message || 'Error al solicitar magic link');
            return false;
        }
    } catch (error) {
        console.error('Error requesting magic link:', error);
        showNotification('error', 'Error de conexión. Inténtalo de nuevo.');
        return false;
    }
}

/**
 * Verify magic link token and login
 * @param {string} token - The magic link token
 */
async function verifyMagicLink(token) {
    try {
        const response = await fetch(apiUrl(`/auth/verify?token=${token}`), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
            credentials: 'include',
        });

        const data = await response.json();

        if (data.success) {
            // Store JWT token
            if (data.data && data.data.access_token) {
                sessionStorage.setItem('jwt_token', data.data.access_token);
                sessionStorage.setItem('user_id', data.data.user.id);
                sessionStorage.setItem('user_email', data.data.user.email);
            }
            showNotification('success', 'Sesión iniciada correctamente');
            return true;
        } else {
            showNotification('error', data.message || 'Token inválido');
            return false;
        }
    } catch (error) {
        console.error('Error verifying magic link:', error);
        showNotification('error', 'Error de conexión. Inténtalo de nuevo.');
        return false;
    }
}

/**
 * Initialize auth state - check for existing session
 */
export function initAuth() {
    const token = sessionStorage.getItem('jwt_token');
    const userId = sessionStorage.getItem('user_id');
    const userEmail = sessionStorage.getItem('user_email');

    if (token && userId) {
        // User is already authenticated
        showAuthUI(true, userId, userEmail);
        return true;
    }

    showAuthUI(false);
    return false;
}

/**
 * Show/hide auth UI
 * @param {boolean} isAuthenticated - Whether user is logged in
 * @param {string} userId - User ID
 * @param {string} userEmail - User email
 */
export function showAuthUI(isAuthenticated, userId, userEmail) {
    const landingAuthActions = document.getElementById('landing-auth-actions');
    const mobileAuthActions = document.getElementById('mobile-auth-actions');
    const backToPanel = document.getElementById('back-to-panel');
    const mobileBackLi = document.getElementById('mobile-back-li');
    const landingLoginCta = document.getElementById('landing-login-cta');
    const landingRegisterCta = document.getElementById('landing-register-cta');

    if (isAuthenticated) {
        // Show authenticated UI
        if (landingAuthActions) landingAuthActions.classList.remove('hidden');
        if (mobileAuthActions) mobileAuthActions.classList.remove('hidden');
        if (backToPanel) backToPanel.classList.remove('hidden');
        if (mobileBackLi) mobileBackLi.classList.remove('hidden');
        if (landingLoginCta) landingLoginCta.classList.add('hidden');
        if (landingRegisterCta) landingRegisterCta.classList.add('hidden');
        
        // Update session banner
        const sessionName = document.getElementById('landing-session-name');
        const sessionBalance = document.getElementById('landing-session-balance');
        if (sessionName) sessionName.textContent = userEmail.split('@')[0] || 'Usuario';
        if (sessionBalance) sessionBalance.textContent = '100'; // Will be updated from API
    } else {
        // Show unauthenticated UI
        if (landingAuthActions) landingAuthActions.classList.add('hidden');
        if (mobileAuthActions) mobileAuthActions.classList.add('hidden');
        if (backToPanel) backToPanel.classList.add('hidden');
        if (mobileBackLi) mobileBackLi.classList.add('hidden');
        if (landingLoginCta) landingLoginCta.classList.remove('hidden');
        if (landingRegisterCta) landingRegisterCta.classList.remove('hidden');
    }
}

/**
 * Show notification (toast/tooltip)
 * @param {'success'|'error'|'info'} type - Notification type
 * @param {string} message - Message to show
 */
export function showNotification(type, message) {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `fixed bottom-4 right-4 px-6 py-3 rounded-2xl shadow-lg ${
        type === 'success' ? 'bg-green-500 text-white' : 
        type === 'error' ? 'bg-red-500 text-white' : 
        'bg-slate-600 text-white'
    }`; notification.textContent = message; notification.setAttribute('role', 'alert');

    document.body.appendChild(notification);

    // Auto-remove after 3 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.parentNode.removeChild(notification);
        }
    }, 3000);
}