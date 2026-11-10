// Editor de borradores: resalta campos "por completar" en amarillo.
// Se integra con el backend para obtener el estado de un documento
// y permite al usuario editar los campos antes de generar el PDF.

import { showError } from './ui.js';

/**
 * Colores y estilos para resaltar campos por completar.
 * El amarillo se usa para indicar que el campo necesita completarse
 * pero aún puede ser editado por el usuario.
 */
const COMPLETING_COLOR = 'rgba(255, 215, 0, 0.3)';
const COMPLETING_BORDER = '2px solid #f5a623';

/**
 * Estados posibles para un campo en el editor.
 */
const FieldStatus = {
    COMPLETING: 'completando',   // Por completar, resaltar en amarillo
    COMPLETED: 'completo',       // Completo, sin resaltar
    EMPTY: 'vacio',              // Vacío, resaltar en rojo suave
    CONFIDENT: 'confiado',       // Con valor confiable (verde)
    UNCERTAIN: 'incierto'        // Valor incierto, amarillo
};

/**
 * Constructor de la clase Editor.
 * Gestiona el resaltado de campos "por completar" en un documento.
 *
 * @param {object} options   Opciones de configuración.
 * @param {string} options.docId         ID del documento.
 * @param {HTMLElement} options.container  Contenedor DOM donde renderizar el editor.
 * @param {string} [options.baseUrl='']  URL base de la API.
 */
export class Editor {
    constructor(options) {
        this.docId = options.docId;
        this.container = typeof options.container === 'string'
            ? document.querySelector(options.container)
            : options.container;
        this.baseUrl = options.baseUrl ?? '';
        this.fieldStyles = null; // Se aplicarán dinámicamente
        this.originalStyles = new Map(); // Para restaurar estilos originales
    }

    /**
     * Inicializa el editor: obtiene el estado del documento del backend
     * y aplica los resaltados correspondientes.
     */
    async init() {
        if (!this.docId || !this.container) {
            console.error('Editor.init: docId y container son obligatorios.');
            return;
        }

        try {
            // Obtener el estado de edición del documento desde el backend.
            // GAP (MIGRATION.md): the unified API has NO
            // /documents/{id}/edit-status route. This module is legacy-only and
            // no page imports it.
            const response = await fetch(
                `${this.baseUrl}/documents/${this.docId}/edit-status`,
                {
                    method: 'GET',
                    headers: {
                        'Accept': 'application/json',
                        // Se asume que la sesión ya está activa (cookie httpOnly).
                    },
                    credentials: 'include',
                }
            );

            if (!response.ok) {
                const errorData = await response.json();
                showError('doc-error', errorData.error?.message || 'No pudimos cargar el estado del documento.');
                return;
            }

            const data = await response.json();
            this.applyEditStatus(data);
        } catch (err) {
            showError('doc-error', err && err.message ? err.message : 'No pudimos conectar con el servidor.');
        }
    }

    /**
     * Aplica el estado de edición al contenedor, resaltando campos
     * "por completar" en amarillo y manejando los estilos restantes.
     *
     * @param {object} status   Estado del documento del backend.
     *   Estructura esperada: { fields: [{ name, value, status, required }] }
     */
    applyEditStatus(status) {
        if (!status || !status.fields) {
            console.warn('Editor.applyEditStatus: no hay datos de campos.');
            return;
        }

        const fields = Array.isArray(status.fields) ? status.fields : [status.fields];

        // Limpiar resaltados previos (restaurar estilos originales).
        this.restoreOriginalStyles();

        fields.forEach(field => {
            const element = this.container.querySelector(`[data-field="${field.name}"]`);
            if (!element) {
                // Si no existe un elemento con ese data-field, crear uno o ignorar.
                // Por ahora, registramos y continuamos.
                console.debug(`Editor: no found element for field "${field.name}"`);
                return;
            }

            // Guardar el estilo original si no hemos guardado aún.
            if (!this.originalStyles.has(element)) {
                this.originalStyles.set(element, {
                    backgroundColor: element.style.backgroundColor,
                    border: element.style.border,
                    color: element.style.color,
                });
            }

            // Aplicar estilo según el estado del campo.
            switch (field.status) {
                case FieldStatus.COMPLETING:
                    // Resaltar en amarillo - campo por completar.
                    element.style.backgroundColor = COMPLETING_COLOR;
                    element.style.border = COMPLETING_BORDER;
                    element.style.color = '#1a1a1a'; // Texto oscuro sobre amarillo
                    break;

                case FieldStatus.COMPLETED:
                    // Quitar resaltado, campo completo.
                    // Ya se restaurará al limpiar, pero establecer estado base.
                    element.style.backgroundColor = '';
                    element.style.border = '';
                    element.style.color = '';
                    break;

                case FieldStatus.EMPTY:
                    // Campo vacío - resaltar suavemente.
                    element.style.backgroundColor = 'rgba(255, 100, 100, 0.1)';
                    element.style.border = '1px solid #ff6464';
                    element.style.color = '#ff6464';
                    break;

                case FieldStatus.CONFIDENT:
                    // Campo con valor confiable - verde muy suave.
                    element.style.backgroundColor = 'rgba(100, 200, 100, 0.1)';
                    element.style.border = '1px solid #64c864';
                    element.style.color = '#64c864';
                    break;

                case FieldStatus.UNCERTAIN:
                    // Valor incierto - amarillo (igual que completing pero distinto contexto).
                    element.style.backgroundColor = COMPLETING_COLOR;
                    element.style.border = COMPLETING_BORDER;
                    element.style.color = '#1a1a1a';
                    break;

                default:
                    // Sin resalto particular.
                    break;
            }
        });
    }

    /**
     * Restaura todos los estilos originales, quitando los resaltados.
     * Se llama al cambiar de documento o al cerrar el editor.
     */
    restoreOriginalStyles() {
        this.originalStyles.forEach((original, element) => {
            element.style.backgroundColor = original.backgroundColor;
            element.style.border = original.border;
            element.style.color = original.color;
        });
        this.originalStyles.clear();
    }

    /**
     * Marca un campo específico como "por completar" resaltando en amarillo.
     * Llena el campo con un placeholder si está vacío.
     *
     * @param {string} fieldName   Nombre del campo.
     * @param {string} [placeholder] Texto placeholder si el campo está vacío.
     */
    markFieldCompletando(fieldName, placeholder = '') {
        const element = this.container.querySelector(`[data-field="${fieldName}"]`);
        if (!element) return;

        // Aplicar estilo de "por completar".
        element.style.backgroundColor = COMPLETING_COLOR;
        element.style.border = COMPLETING_BORDER;
        element.style.color = '#1a1a1a';

        // Si el campo está vacío, poner placeholder.
        if (placeholder && (element.value === '' || element.textContent === '')) {
            element.textContent = placeholder;
            element.style.color = 'rgba(26, 26, 26, 0.5)';
        }
    }

    /**
     * Marca un campo como completado (quita el resalte amarillo).
     *
     * @param {string} fieldName Nombre del campo.
     */
    markFieldCompleted(fieldName) {
        const element = this.container.querySelector(`[data-field="${fieldName}"]`);
        if (!element) return;

        // Quitar estilo de "por completar".
        element.style.backgroundColor = '';
        element.style.border = '';
        element.style.color = '';
    }

    /**
     * Obtiene el valor actual de un campo.
     *
     * @param {string} fieldName Nombre del campo.
     * @returns {string} Valor actual del campo (vacío si no hay valor).
     */
    getFieldValue(fieldName) {
        const element = this.container.querySelector(`[data-field="${fieldName}"]`);
        if (!element) return '';

        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
            return element.value.trim();
        }
        return element.textContent.trim();
    }

    /**
     * Establece el valor de un campo y quita el resalte "por completar".
     *
     * @param {string} fieldName   Nombre del campo.
     * @param {string} value       Valor a establecer.
     */
    setFieldValue(fieldName, value) {
        const element = this.container.querySelector(`[data-field="${fieldName}"]`);
        if (!element) return;

        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
            element.value = value;
        } else {
            element.textContent = value;
        }

        // Quitar resaltado al establecer valor.
        element.style.backgroundColor = '';
        element.style.border = '';
        element.style.color = '';
    }
}

/**
 * Inicializa el editor para un documento específico.
 *
 * @param {string} docId       ID del documento.
 * @param {string} containerId ID del contenedor HTML (ej. '#document-editor').
 * @param {string} [baseUrl=''] URL base de la API.
 */
export function initEditor(docId, containerId, baseUrl = '') {
    const container = document.querySelector(containerId);
    if (!container) {
        console.error(`Editor.init: contenedor "${containerId}" no encontrado.`);
        return null;
    }

    const editor = new Editor({
        docId,
        container,
        baseUrl,
    });

    editor.init();
    return editor;
}