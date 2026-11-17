/**
 * chat-only-guard — make `web_search` and `web_fetch` the ONLY tools a
 * Chat Only session can see or call.
 *
 * WHY THIS ROW EXISTS AT ALL: a preset that simply omits tool rows still
 * inherits every tool registered on the HOST plane. The Web composition moves
 * most tool rows into presets, but `working_directory`, the MCP resource
 * tools, and anything a profile plugin registers (memory, diagrams, browser,
 * task board, …) live on the host and reach every preset. Omitting rows
 * cannot hide those, so this row applies an allow mask instead.
 *
 * WHY THE MASK GOES ON THE AGENT SCOPE, NOT THIS PRESET'S SCOPE: a tool
 * restriction filters the tools a scope INHERITS, and a scope's own
 * registrations are exempt from its own mask. `tool-web` registers
 * `web_search`/`web_fetch` in this preset's scope, so a mask placed here
 * would be inherited by the Agent and would filter those two right along
 * with everything else — leaving a session with no tools at all. Placing the
 * mask on each Agent scope instead leaves this preset's registrations exempt
 * (they are inherited by the Agent, not owned by it) and hides exactly the
 * host-plane tools we want gone.
 *
 * WHY AN ALLOW LIST AND NOT A DENY LIST: a deny list has to name every tool
 * that must disappear, so every future host release and every newly installed
 * profile plugin would silently leak a tool into this mode. An allow list
 * fails closed: a tool nobody thought about stays hidden.
 *
 * The `tools/pre-execute` gate is the second line of defence. The mask keeps
 * a tool out of the model's schema, so a well-behaved model never calls one;
 * the gate covers a hallucinated call and any row added to this preset later,
 * and answers with a readable reason instead of a bare `UNKNOWN_TOOL`.
 *
 * Every step degrades to "keep working" rather than failing the Agent: a
 * guard bug must never make a session unopenable.
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 'chat-only-guard'

/**
 * The complete model-visible toolset of this mode. Names are the registered
 * tool names, not the plugin package names.
 */
const ALLOWED_TOOLS = Object.freeze(['web_search', 'web_fetch'])

/** Membership set for the pre-execute gate. */
const ALLOWED = new Set(ALLOWED_TOOLS)

/**
 * The reason a blocked call reports. Written for the model to read: it names
 * the mode and the two tools that do exist, so a confused model can correct
 * itself instead of retrying.
 */
const DENIED_REASON = `This session runs in Chat Only mode: web_search and web_fetch are the only tools available. `
  + `There is no shell, no filesystem, no code execution, and no way to change anything on this machine. `
  + `Answer from the conversation and from web results instead.`

/**
 * Apply the allow mask to one Agent scope.
 *
 * `tools.restrict()` rejects a name it cannot resolve, so a deployment without
 * a search provider would make the full allow list throw. The fallback is an
 * EMPTY allow list rather than no mask at all: hiding every tool is the
 * fail-closed outcome, while skipping the mask would hand the session the
 * whole host toolset.
 *
 * The mask is applied through `agent.ctx.get('tools')`, whose traceable proxy
 * makes `restrict()` run against the Agent's own scope. That is what keeps
 * this preset's `web_search`/`web_fetch` registrations exempt: they are
 * inherited by the Agent, not owned by it, so the Agent's mask filters the
 * host-plane tools and leaves those two visible.
 *
 * @param ctx - this preset's scoped context, used for logging only.
 * @param agent - the Agent whose scope receives the mask.
 */
function maskAgentTools(ctx, agent) {
  const tools = agent.ctx.get('tools')
  if (tools === undefined) {
    ctx.logger?.warn?.('chat-only-guard: no tools service on the Agent scope; the allow mask was not applied')
    return
  }
  try {
    tools.restrict({ allow: ALLOWED_TOOLS })
  } catch (error) {
    ctx.logger?.warn?.(`chat-only-guard: allow list rejected (${String(error)}); hiding every tool instead`)
    tools.restrict({ allow: [] })
  }
}

/**
 * Register the Agent-scope mask and the pre-execute gate.
 * @param ctx - the preset-scoped context this row is mounted under.
 */
export function apply(ctx) {
  // `agent/created` is serial and awaited before the Agent accepts work, so
  // the mask is in place before the first step assembles its tool schemas.
  // A throw here would fail Agent creation, hence the catch.
  ctx.on('agent/created', ({ agent }) => {
    try {
      maskAgentTools(ctx, agent)
    } catch (error) {
      ctx.logger?.warn?.(`chat-only-guard: could not apply the allow mask: ${String(error)}`)
    }
  })

  // Scope-filtered dispatch: this listener only sees calls from Agents composed
  // under this preset, so other modes are untouched. A call with no Agent is a
  // programmatic host call, not a model call, and passes through: this mode
  // constrains what the MODEL may do, not what the harness does internally.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec?.agent === undefined) return next()
    const toolName = exec?.name
    if (typeof toolName === 'string' && ALLOWED.has(toolName)) return next()
    return { kind: 'deny', reason: DENIED_REASON }
  })
}
