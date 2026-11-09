/**
 * dsh-session-delete browser half.
 *
 * Adds one row to the sidebar Session menu: "Delete session". The row is data,
 * not a component — the Context Menu service renders it, handles dismissal and
 * keyboard movement, and runs it. The click confirms, then posts the id to the
 * Host half, which owns the one deletion operation. The Host reports the
 * removal back as `api-session/removed`, so the sidebar drops the row without a
 * page reload.
 *
 * @module dsh-session-delete/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-delete',

  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace for this plugin's copy. */
    const LOCALE_NS = 'session-delete'

    /** Same-origin route registered by the Host half. */
    const DELETE_ROUTE = '/session-delete/delete'

    const en = {
      'menu.deleteSession': 'Delete session',
      'confirm.message': 'Permanently delete this session and its log? This cannot be undone.',
      'notice.failed': 'The session was not deleted.',
      'notice.invalid': 'The request was refused.',
    }

    const zh = {
      'menu.deleteSession': '删除会话',
      'confirm.message': '永久删除此会话及其日志？此操作无法撤销。',
      'notice.failed': '会话未删除。',
      'notice.invalid': '请求被拒绝。',
    }

    /**
     * Delete one session through the Host route.
     * @param sessionId - the row's session id.
     * @param t - translate function bound to this plugin's namespace.
     */
    async function requestDelete(sessionId, t) {
      if (!window.confirm(t('confirm.message'))) return
      let response
      try {
        response = await fetch(DELETE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
      } catch {
        window.alert(`${t('notice.failed')} ${t('notice.invalid')}`)
        return
      }
      if (response.ok) return
      let reason = ''
      try {
        const body = await response.json()
        if (typeof body?.message === 'string') reason = body.message
      } catch {
        // An unparsable failure body still reports the localized refusal.
      }
      window.alert(reason === '' ? t('notice.failed') : `${t('notice.failed')} ${reason}`)
    }

    /**
     * Trash glyph for the menu row.
     * @returns the icon element.
     */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3 4.5h10' }),
      h('path', { d: 'M6.5 4.5V3.2h3v1.3' }),
      h('path', { d: 'M4.4 4.5l.6 8.1h6l.6-8.1' }),
      h('path', { d: 'M6.8 6.8v3.6M9.2 6.8v3.6' }))
    }

    /**
     * Mount the menu row and its icon.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      const t = ctx.locale.bind(LOCALE_NS)
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'session-delete: locale dictionary')

      ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
        name: 'contextMenu.icon',
        key: 'session-delete.trash',
      }, TrashIcon))

      ctx.effect(() => ctx.contextMenus.register({
        id: 'session.delete',
        target: 'session',
        order: 550,
        resolve: ({ sessionId }) => [{
          id: 'delete',
          label: t('menu.deleteSession'),
          icon: { key: 'session-delete.trash' },
          separatorBefore: true,
          danger: true,
          run: () => {
            void requestDelete(sessionId, t)
          },
        }],
      }), 'session-delete: Delete session menu row')
    }

    exports.apply = apply
    exports.inject = ['contextMenus', 'locale', 'slots']
    return module.exports
  },
})
