/**
 * DeepSeek Harness session deletion.
 *
 * The Harness ships no delete operation for stored sessions: a session is a
 * directory under the sessions root holding an append-only log plus a lock
 * file, and the persistence service only creates, opens, lists, and stats
 * them. This plugin owns the missing operation once, and exposes it to the two
 * callers that need it: the sidebar Session menu (through a same-origin route)
 * and the agent (through the `session_delete` tool).
 *
 * Safety rules, all enforced in `deleteStoredSession`:
 * - the id must be a canonical session id;
 * - a live or in-memory session is refused, never torn out from under a
 *   running agent;
 * - the directory must come from the persistence snapshot for that exact id,
 *   be named after the id, and look like a session artifact directory.
 *
 * @module dsh-session-delete
 */
import { readdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/** Same-origin route the sidebar calls. */
export const DELETE_ROUTE = '/session-delete/delete'

/** Canonical stored session identity. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Request bodies above this size are rejected rather than buffered. */
const MAX_BODY_BYTES = 16 * 1024

/** Session artifact file names that a directory must contain to be deleted. */
const LOG_FILE = /^session\.[A-Za-z0-9.-]*jsonl(\.zstd)?$/

export const inject = ['sessionPersistence']

/**
 * Mount the route and the tool.
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const deleteSession = (sessionId) => deleteStoredSession(ctx, sessionId)

  ctx.inject(['tools'], (scope) => {
    scope.effect(
      () => scope.tools.register(createDeleteTool(deleteSession)),
      'session-delete: session_delete tool',
    )
  })

  ctx.inject(['webServer', 'connection'], (scope) => {
    scope.effect(
      () => scope.webServer.register({
        kind: 'exact',
        path: DELETE_ROUTE,
        handler: createRouteHandler(scope, deleteSession),
      }),
      `session-delete: POST ${DELETE_ROUTE}`,
    )
  })
}

/**
 * Delete one stored session's artifact directory.
 * @param ctx - a context that can reach sessionPersistence, agents, and sessions.
 * @param sessionId - the requested session id, however malformed.
 * @returns `{ ok: true, sessionId }` or `{ ok: false, error, message }`.
 */
export async function deleteStoredSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    return failure('invalid-session-id', 'Not a canonical session id.')
  }

  const live = ctx.get('agents')?.get(sessionId)
  if (live !== undefined) {
    return failure('session-live', 'The session is open. Close it, then delete it.')
  }
  const retained = ctx.get('sessions')?.get(sessionId)
  if (retained !== undefined) {
    return failure('session-live', 'The session is still in memory. Close it, then delete it.')
  }

  let snapshot
  try {
    snapshot = await ctx.sessionPersistence.stat(sessionId)
  } catch (error) {
    return failure('stat-failed', messageOf(error))
  }
  if (snapshot === undefined) return failure('not-found', 'No stored session has this id.')

  const logPath = snapshot.location?.path
  const directory = logPath === undefined ? undefined : dirname(logPath)
  if (directory === undefined || basename(directory) !== sessionId) {
    return failure('unexpected-location', 'The stored session does not look like a session directory.')
  }

  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    return failure('read-failed', messageOf(error))
  }
  const artifact = entries.some((entry) => entry === 'session.lock' || LOG_FILE.test(entry))
  if (!artifact) {
    return failure('unexpected-location', 'The stored session directory holds no session log or lock.')
  }

  try {
    await rm(directory, { recursive: true, force: true })
  } catch (error) {
    return failure('delete-failed', messageOf(error))
  }

  // The list lives on persisted artifacts; telling the live page about the
  // removal is what makes the row disappear without a reload.
  ctx.emit('api-session/removed', sessionId)
  return { ok: true, sessionId }
}

/**
 * Build the model-facing delete tool.
 * @param deleteSession - the one deletion operation.
 * @returns a registry-ready tool definition.
 */
function createDeleteTool(deleteSession) {
  return {
    name: 'session_delete',
    description:
      'Permanently delete one stored DeepSeek Harness session and its log. '
      + 'The session must not be open. Deletion cannot be undone, and no archive copy is kept.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Exact stored session id, including the leading "session-".',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          sessionId: { type: 'string' },
          error: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok'],
        additionalProperties: false,
      },
      render(_args, value) {
        const text = value.ok === true
          ? `Deleted session ${String(value.sessionId)}.`
          : `Session not deleted: ${String(value.message ?? value.error ?? 'unknown failure')}`
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      exec?.signal?.throwIfAborted()
      return await deleteSession(args?.sessionId)
    },
  }
}

/**
 * Build the same-origin route handler the sidebar calls.
 * @param scope - context that owns webServer and connection.
 * @param deleteSession - the one deletion operation.
 * @returns a Node-style request handler.
 */
function createRouteHandler(scope, deleteSession) {
  return async (req, res) => {
    const rejection = scope.connection.requestRejection(req)
    if (rejection !== undefined) {
      res.statusCode = rejection
      res.end()
      return
    }
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }

    let body
    try {
      body = await readBody(req)
    } catch (error) {
      res.statusCode = error?.code === 'BODY_TOO_LARGE' ? 413 : 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(failure('bad-request', messageOf(error))))
      return
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(failure('bad-json', 'Expected a JSON request body.')))
      return
    }

    const result = await deleteSession(payload?.sessionId)
    res.statusCode = result.ok === true ? 200 : result.error === 'not-found' ? 404 : 409
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(result))
  }
}

/**
 * Read a small JSON body.
 * @param req - the incoming request.
 * @returns the UTF-8 body text.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

/**
 * Shape one failure result.
 * @param error - stable machine code.
 * @param message - human-readable reason.
 * @returns the failure result.
 */
function failure(error, message) {
  return { ok: false, error, message }
}

/**
 * Read an error's message.
 * @param error - any thrown value.
 * @returns its message text.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}
