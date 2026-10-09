// DeepSeek Harness adapter for obra/superpowers.
//
// The upstream repository targets Pi / OpenCode / Claude Code and friends; it
// has no DSH plugin surface. This file is the whole port: everything DSH needs
// in order to mount the *unmodified* upstream `skills/` tree.
//
// Three surfaces, and nothing else:
//
//   1. `ctx.skills.registerProvider` — makes the packaged skills discoverable by
//      the host registry, so every agent preset's scope chain merges them. Skill
//      bodies stay unread until the model actually calls the `skill` tool, which
//      is what `get()` defers.
//
//   2. `ctx.systemPrompt.section` — the bootstrap. Upstream enforces its mandate
//      from a per-harness session-start hook (Claude Code, Antigravity, Muse,
//      Pi, Hermes). DSH has no equivalent hook, but a prompt section is rebuilt
//      into every request, which is strictly stronger: it survives compaction
//      with no re-inject pass. The installed `superpowers-dsh` package omits this,
//      so the mandate is only advisory there; this adapter restores it.
//
//   3. `ctx.systemPrompt.context` — the per-request reminder. The bootstrap
//      section is reconciled into a retained system node, so in a long session
//      it sits at the head of history where attention decays. The runtime
//      context is re-rendered every request and supersedes its earlier copies,
//      which puts the "check for a skill" instruction next to the current turn.
//
// Deliberately absent: no rewriting of skill text. Upstream already writes its
// skills tool-neutral — verified across all 15 SKILL.md files, none calls a
// Claude-Code tool name — so the port has nothing to translate and the tree can
// track upstream verbatim. `resources/*` files are still needed, because a
// skill body references them by relative path.
//
// @module dsh-adapter

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Stable cordis plugin name.
 *
 * Must equal package.json `name`: the loader resolves the bundle row's `name`
 * against the installed package, and a mismatch makes the plugin silently fail
 * to mount — no tools, no routes, no error.
 */
const name = 'superpowers'

/** Services required before either surface can mount. */
const inject = ['skills', 'systemPrompt']

/**
 * Registry precedence for packaged skill providers. Ranks below the local
 * bundled root so a user-authored `SKILL.md` of the same name still wins.
 */
const PACKAGED_SKILL_RANK = 550

/** The source bucket these skills advertise under (prompt-visible metadata). */
const SOURCE = 'custom'

/** Order within the prompt's section band: ahead of generic tool guidance. */
const SECTION_ORDER = 160

/**
 * Order of the per-request runtime-context reminder.
 *
 * The runtime-context band is a separate sort space from sections, and DSH
 * allocates its known placements itself: SANDBOX_POLICY 110, APPROVAL_POLICY
 * 115, SUBAGENT_DELEGATION 120. External contributors pick any finite order;
 * 125 lands after delegation policy and before generic tool guidance, so the
 * reminder reads with the policy text rather than after it.
 */
const CONTEXT_ORDER = 125

/**
 * The per-request reminder that the model check for a skill.
 *
 * Why this exists separately from the bootstrap section: the section is
 * assembled once per request series and is reconciled into a retained system
 * node, so a long conversation carries it only at the head of history where
 * attention decays. The runtime-context snapshot is re-rendered from scratch
 * on every request and supersedes its own earlier copies, so this text arrives
 * adjacent to the current turn instead of trailing far behind it.
 *
 * Deliberately short. Repeating the full `<EXTREMELY-IMPORTANT>` mandate every
 * request spends tokens restating a rule that is already in the system prompt
 * and adds nothing the one-line pointer does not.
 */
const REMINDER_TEXT = [
  '**superpowers**: this session has skills available through the `skill` tool.',
  'If `using-superpowers` has not been loaded yet, invoke it before your first response.',
  'For each task, check the skill catalog for a skill that fits and invoke it before acting.',
].join('\n')

/**
 * Parse the YAML frontmatter block of a SKILL.md into metadata plus body.
 *
 * Handles only the scalar fields DSH skill discovery consumes (name,
 * description, whenToUse); richer metadata passes through verbatim.
 *
 * @param text - the raw skill file contents.
 * @returns parsed metadata object and the markdown body after the block, or
 *   null when the file has no frontmatter block at all.
 */
function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const block = text.slice(3, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const metadata = {}
  for (const line of block.split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim())
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    metadata[match[1]] = value
  }
  return { metadata, body }
}

/**
 * Read and parse one skill directory's SKILL.md.
 *
 * @param skillFile - absolute path to the SKILL.md file.
 * @param signal - optional cancellation; aborts the read.
 * @returns the parsed skill record, or undefined when the file vanished.
 */
async function parseSkillFile(skillFile, signal) {
  let text
  try {
    text = await readFile(skillFile, 'utf8')
  } catch {
    return undefined
  }
  if (signal?.aborted) return undefined
  const parsed = parseFrontmatter(text)
  if (parsed === null) return undefined
  return {
    name: parsed.metadata.name ?? '',
    description: parsed.metadata.description ?? '',
    whenToUse: parsed.metadata.whenToUse,
    metadata: parsed.metadata,
    content: parsed.body,
  }
}

/**
 * Discover packaged skill candidates by scanning the package's `skills/`
 * directory: one subdirectory per skill, each carrying a SKILL.md.
 *
 * @param skillsRoot - absolute path to this package's skills directory.
 * @param signal - optional cancellation.
 * @returns the candidate list.
 */
async function discoverCandidates(skillsRoot, signal) {
  let entries
  try {
    entries = await readdir(skillsRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (signal?.aborted) break
    if (!entry.isDirectory()) continue
    const skillDir = join(skillsRoot, entry.name)
    const skillFile = join(skillDir, 'SKILL.md')
    const parsed = await parseSkillFile(skillFile, signal)
    if (parsed === undefined) continue
    candidates.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: { modelInvocable: true, userInvocable: true },
      source: SOURCE,
      provider: name,
      rank: PACKAGED_SKILL_RANK,
      locator: skillDir,
      path: skillFile,
      ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
    })
  }
  return candidates
}

/**
 * The bootstrap the system prompt advertises.
 *
 * Read from the packaged `using-superpowers/SKILL.md` rather than duplicated
 * here, so a rebase that rewrites the skill body cannot leave this section
 * quoting a stale copy. Only the frontmatter is stripped.
 *
 * The slice runs from the start of the body — where the `<EXTREMELY-IMPORTANT>`
 * mandate lives — up to `## Skill Priority`, so the injected text keeps both
 * halves that make a skill actually fire: the mandate and the rule. A rebase
 * that renames that heading falls back to the whole body: over-injecting is the
 * safe direction for an enforcement mechanism, because the skill catalog still
 * advertises every skill either way.
 *
 * @param skillsRoot - absolute path to this package's skills directory.
 * @returns the body, or an empty string when the file is unavailable.
 */
async function loadBootstrap(skillsRoot) {
  const text = await readFile(join(skillsRoot, 'using-superpowers', 'SKILL.md'), 'utf8')
  const parsed = parseFrontmatter(text)
  if (parsed === null) return ''
  const head = parsed.body.match(/^[\s\S]*?(?=\n## Skill Priority)/)
  return (head === null ? parsed.body : head[0]).trim()
}

/**
 * Mount both surfaces.
 *
 * @param ctx - host plugin context carrying skills and systemPrompt.
 */
function apply(ctx) {
  const skillsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills')

  ctx.skills.registerProvider((control) => ({
    name,
    async list(options) {
      return discoverCandidates(skillsRoot, options.signal ?? control.signal)
    },
    async get(candidate, options) {
      const parsed = await parseSkillFile(candidate.path, options.signal)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SOURCE,
        provider: name,
        resourceBase: { kind: 'directory', path: candidate.locator },
        path: candidate.path,
        ...(Object.keys(parsed.metadata).length > 0 ? { metadata: parsed.metadata } : {}),
        content: parsed.content,
      }
    },
  }))

  // Failure policy mirrors the skills half: a prompt section that fails to mount
  // must not take the plugin down, and with it the whole web boot.
  void (async () => {
    try {
      const text = await loadBootstrap(skillsRoot)
      if (text !== '') {
        ctx.systemPrompt.section({
          name: 'plugin:superpowers',
          order: SECTION_ORDER,
          text,
        })
      }
    } catch (error) {
      console.warn('[superpowers-dsh] prompt section failed:', error)
    }

    // Registered independently of the bootstrap: the reminder is a pointer, not
    // a copy of the mandate, so it stays useful when `loadBootstrap` returns ''
    // or throws. One throw must not skip the other surface.
    try {
      ctx.systemPrompt.context({
        name: 'plugin:superpowers-reminder',
        order: CONTEXT_ORDER,
        text: REMINDER_TEXT,
      })
    } catch (error) {
      console.warn('[superpowers-dsh] prompt context failed:', error)
    }
  })()
}

export { apply, discoverCandidates, inject, loadBootstrap, name, parseFrontmatter }
export default { apply, discoverCandidates, inject, loadBootstrap, name, parseFrontmatter }
