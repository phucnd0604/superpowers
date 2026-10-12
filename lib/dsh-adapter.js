// DeepSeek Harness adapter for obra/superpowers.
//
// The upstream repository targets Pi / OpenCode / Claude Code and friends; it
// has no DSH plugin surface. This file is the whole port: everything DSH needs
// in order to mount the *unmodified* upstream `skills/` tree.
//
// Two surfaces, and nothing else:
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
// The bootstrap is a pointer, not a copy of `using-superpowers`. Two reasons it
// does not inline the skill:
//
//   - A section is rebuilt into every request, so every quoted character is a
//     per-request cost. This one previously quoted an 885-char slice of the
//     skill body on every single call.
//   - A partial copy is worse than none. That slice ended just before
//     `## Skill Priority`, so the model received the mandate without the rule
//     for choosing between skills, and without the Red Flags table that catches
//     rationalization. "Invoke a skill" with no way to pick one is an
//     instruction the model can satisfy without the skills doing anything.
//
// The rule is loaded once, in full, through the `skill` tool — which is what the
// provider half already defers bodies for. A separate `systemPrompt.context`
// reminder also used to ride each request; it duplicated the section and, as
// runtime context, was the surface a preset can suppress. The per-task nudge
// now lives in the section, which is rebuilt per request anyway.
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
 * The bootstrap the system prompt carries on every request.
 *
 * A pointer, never a copy. It names the skill and the tool that loads it, and
 * the model pulls the rule itself; nothing here paraphrases the mandate, because
 * a paraphrase is either a truncation (losing `## Skill Priority` and the Red
 * Flags table, which is how a section can end up less useful than no section)
 * or a duplication that rides every request forever.
 *
 * The third paragraph is the reason this surface is rebuilt per request rather
 * than injected once at session start: the user wants the model consulting the
 * superpowers workflow on every new task, not only the first one. A section that
 * the host reconciles into each request delivers that; nothing else available
 * here would.
 *
 * `<EXTREMELY-IMPORTANT>` and `<SUBAGENT-STOP>` keep their upstream names, but
 * they no longer carry their upstream meaning — those markers belong to a full
 * skill, and this is a pointer to one. They are kept because the marker is what
 * the model reads as an enforced instruction.
 */
const BOOTSTRAP_TEXT = [
  '<SUBAGENT-STOP>',
  'If you were dispatched as a subagent to execute a specific task, ignore this block.',
  '</SUBAGENT-STOP>',
  '',
  '<EXTREMELY-IMPORTANT>',
  'This session runs on Superpowers skills, loadable with the `skill` tool.',
  '',
  'Invoke the `using-superpowers` skill before your first response and follow it: it',
  'decides which skill or workflow applies and in what order.',
  '',
  'For each new task, check the skill catalog and invoke what fits before acting.',
  '</EXTREMELY-IMPORTANT>',
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
  // must not take the plugin down, and with it the whole web boot. The text is a
  // constant, so registration is synchronous and stays that way — no floating
  // await between here and the call the host observes.
  try {
    ctx.systemPrompt.section({
      name: 'plugin:superpowers',
      order: SECTION_ORDER,
      text: BOOTSTRAP_TEXT,
    })
  } catch (error) {
    console.warn('[superpowers-dsh] prompt section failed:', error)
  }
}

export { apply, discoverCandidates, inject, name, parseFrontmatter }
export default { apply, discoverCandidates, inject, name, parseFrontmatter }
