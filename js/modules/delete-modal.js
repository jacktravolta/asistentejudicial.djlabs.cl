// Delete modal module for Asistente Judicial
// Implements the "BORRAR mis datos" modal with double confirmation

/**
 * Show the delete data confirmation modal.
 * 
 * This modal asks for explicit confirmation with the word "BORRAR"
 * to prevent accidental data loss. It outlines what will be deleted
 * and what will be conserved.
 * 
 * @param {object} options - Configuration options
 * @param {string} options.userId - The current user's ID
 * @param {Function} options.onConfirm - Callback when user confirms with "BORRAR"
 * @param {Function} options.onCancel - Callback when user cancels
 */
export function showDeleteModal({ userId, onConfirm, onCancel }) {
    // Prevent if modal already exists
    if (document.getElementById('delete-modal')) {
        return;
    }

    // Build the modal HTML
    const modalHtml = `
        <div id="delete-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
            <div class="bg-white rounded-xl w-full max-w-md mx-4 sm:mx-6 md:mx-8 p-6 sm:p-8 shadow-2xl border border-gray-200">
                <div class="flex items-start justify-between mb-4">
                    <div>
                        <h2 class="text-2xl font-bold text-gray-900 mb-1">Eliminar mis datos</h2>
                        <p class="text-sm text-gray-500">Esta acción es irreversible</p>
                    </div>
                    <button 
                        id="delete-modal-close" 
                        class="p-2 rounded hover:bg-gray-100 transition-colors"
                        aria-label="Cancelar"
                    >
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                                  d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div class="space-y-4">
                    <p class="text-sm text-gray-600">
                        Al hacer clic en "BORRAR", eliminarás permanentemente:
                    </p>

                    <ul class="list-disc list-inside space-y-2 text-gray-600">
                        <li>
                            ✅ Se borrarán:
                            <ul class="list-circle list-inside text-sm mt-1 text-gray-500">
                                <li>Tus borradores de documentos actuales</li>
                                <li>El contexto de tu sesión actual</li>
                                <li>Tus extractos y búsquedas temporales</li>
                                <li>Los embeddings de la sesión</li>
                            </ul>
                        </li>
                        <li>
                            📋 Se conservará:
                            <ul class="list-circle list-inside text-sm mt-1 text-gray-500">
                                <li>Tu cuenta de usuario</li>
                                <li>Tu historial de créditos y movimientos</li>
                                <li>Tus configuraciones y preferencias</li>
                                <li>La posibilidad de recargar créditos</li>
                            </ul>
                        </li>
                    </ul>

                    <p class="text-xs text-gray-400">
                        ⚠️ Nota: Los respaldos del sistema tienen retención de 30 días,
                        pero los datos de trabajo se eliminan permanentemente después
                        de este proceso. Los proveedores externos (S3) eliminarán los
                        archivos en un plazo máximo de 24 horas.
                    </p>
                </div>

                <div class="space-y-3 pt-4 border-t border-gray-100">
                    <!-- Cancel button -->
                    <button 
                        id="delete-modal-cancel" 
                        class="w-full py-2 px-4 rounded text-sm font-medium text-gray-700 bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                        Cancelar
                    </button>

                    <!-- Confirm button - requires exact text "BORRAR" -->
                    <button 
                        id="delete-modal-confirm" 
                        class="w-full py-2 px-4 rounded text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors"
                        aria-label="Eliminar datos permanentes"
                    >
                        BORRAR
                    </button>
                </div>
            </div>
        </div>
    `;

    // Insert modal into DOM
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Focus management - focus the confirm button
    const confirmBtn = document.getElementById('delete-modal-confirm');
    if (confirmBtn) {
        confirmBtn.focus();
    }

    // Close button handler
    const closeBtn = document.getElementById('delete-modal-close');
    if (closeBtn) {
        closeBtn.onclick = () => {
            document.body.removeChild(document.getElementById('delete-modal'));
            if (onCancel) onCancel();
        };
    }

    // Cancel button handler
    const cancelBtn = document.getElementById('delete-modal-cancel');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            document.body.removeChild(document.getElementById('delete-modal'));
            if (onCancel) onCancel();
        };
    }

    // Confirm button handler - requires exact "BORRAR" text
    const confirmHandler = () => {
        const text = confirmBtn.textContent.trim();
        if (text === 'BORRAR') {
            document.body.removeChild(document.getElementById('delete-modal'));
            if (onConfirm) onConfirm(userId);
        } else {
            // Visual feedback - shake animation
            confirmBtn.style.animation = 'shake 0.4s ease';
            setTimeout(() => {
                confirmBtn.style.animation = '';
            }, 400);
        }
    };

    confirmBtn.onclick = confirmHandler;

    // Handle Escape key
    const handleEscape = (e) => {
        if (e.key === 'Escape') {
            document.body.removeChild(document.getElementById('delete-modal'));
            document.removeEventListener('keydown', handleEscape);
            if (onCancel) onCancel();
        }
    };
    document.addEventListener('keydown', handleEscape);
}

/**
 * Initialize delete modal integration with session service.
 * Sets up the "Borrar datos" button in the UI.
 * 
 * @param {string} baseUrl - Base API URL
 * @returns {Function} Cleanup function
 */
// GAP (MIGRATION.md): the unified API has NO /sessions/complete-deletion
// route — this module is legacy-only and no page imports it. The default
// base is the unified API origin so the request at least leaves the front
// host; the route itself must be implemented server-side before use.
export function initDeleteModalIntegration(baseUrl = '') {
    // Find the delete data button
    const deleteBtn = document.querySelector('[data-delete-trigger]');
    
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            // Get user ID from session storage or metadata
            const userId = sessionStorage.getItem('user_id');
            if (!userId) {
                showNotification('error', 'No se pudo identificar el usuario');
                return;
            }

            // Show the modal
            showDeleteModal({
                userId,
                onConfirm: async (userId) => {
                    // Disable confirm button during process
                    const btn = document.getElementById('delete-modal-confirm');
                    if (btn) btn.disabled = true;
                    
                    try {
                        // Call backend delete processor
                        const response = await fetch(`${baseUrl}/sessions/complete-deletion/${userId}`, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                            },
                        });

                        const data = await response.json();

                        if (data.success) {
                            showNotification('success', data.message || 'Eliminación completada');
                            // Reload or navigate away
                            setTimeout(() => {
                                // This module lives in /js/modules/, hence the
                                // '../../' hop back to the site root.
                                window.location.href = new URL('../../index.html', import.meta.url).href;
                            }, 2000);
                        } else {
                            showNotification('error', data.message || 'Error en la eliminación');
                        }
                    } catch (error) {
                        console.error('Error en eliminación:', error);
                        showNotification('error', 'Error de conexión al eliminar datos');
                    } finally {
                        // Re-enable button
                        if (btn) btn.disabled = false;
                    }
                },
                onCancel: () => {
                    // User cancelled, just close modal
                },
            });
        });
    }

    return () => {
        // Cleanup - remove event listener
        if (deleteBtn) {
            deleteBtn.removeEventListener('click', () => {});
        };
    };
}