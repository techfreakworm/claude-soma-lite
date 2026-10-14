# Open-source readiness audit

> **A pre-launch working document for the operator.** It lists what has to change before
> claude-soma-lite is published, and why. It names each private finding by file, line, category
> and suggested fix, and describes it ("employer name", "client product name", "operator home
> path") **without reproducing the private string itself**. The owner-facing version of the audit,
> which quotes every literal, is not part of the repository and must never be committed to it.
> The commit ids this document cites refer to the private development repository's history and do
> not exist in the public repository. Delete this file before publishing, or keep it, at the
> operator's discretion.

| | |
|---|---|
| Audited tree | local `main` at `9ca4293`: 102 tracked files and 410 commits. Line numbers in §5 refer to that commit. |
| Also checked | the documentation commits on this branch (`soma/soma-lite-manager`), which sits on top of local `main` |
| Date | 2026-10-10 |
| Method | Regex sweeps of every tracked file and of all 798 historical blobs; a line-by-line read of all 102 files; every commit's author, committer, trailers, subject and body; the branch names; the private GitHub repository's pull request and issues; and a cross-check against an independent census of 983 flagged entries (on 798 distinct lines), every one of which is covered by a row in §5.5. |
| Status | Updated 2026-10-10 on the launch branch (`soma/soma-lite-launch`): all 71 must-fix findings are resolved, and §5.5 marks every row the branch resolved with the commit that resolved it (§5.1). |

- [1. Launch blockers](#1-launch-blockers)
- [2. Licence decision record](#2-licence-decision-record)
- [3. Third-party attribution](#3-third-party-attribution)
- [4. Policy review before launch](#4-policy-review-before-launch)
- [5. Findings](#5-findings)
- [Appendix A. Documentation drift to fix before launch (outside this branch)](#appendix-a-documentation-drift-to-fix-before-launch-outside-this-branch)
- [Appendix B. Code follow-ups](#appendix-b-code-follow-ups)

## 1. Launch blockers

### 1a. Publish from local `main`: `origin/main` is 157 commits behind

`origin/main` is at `d5f96e1`, **157 commits behind local `main` at `9ca4293`**, and has nothing
that local `main` lacks. Local `main` is the source of truth: it is what the fleet runs, and
everything after `d5f96e1`, including most of account rotation and the seat-order change, exists
only there. Before launch, either push local `main` or build the public repository directly from it.
That is the operator's call; this branch never pushes.

### 1b. Git history carries every finding: publish into a new repository with fresh history

**Scrubbing the current tree is not enough.** No private string exists only in history, but every
private string in the tree is also in the history, in every version of every file since it landed.
A clean-up commit on top of `main` would leave all of it reachable in the published history.

- **About 165 of the 410 commits** on `main` carry private metadata or private content: 164 with
  the owner-facing audit's patterns, and 161 to 177 depending on which pattern families are counted.
  - **1 commit** (`7a287bc`, 2026-07-30) is authored and committed with a **company-domain email
    address**. Every other commit uses the owner's personal address. It is already on every
    branch of the private GitHub remote.
  - **125 commits** carry a `Claude-Session:` trailer that links a private Claude Code session.
  - Commit bodies name real internal ticket keys (4 commits), real Claude session ids (1), the
    operator's personal MCP servers (3), and the operator's config directories and tmux sockets
    (13).
  - **About 65 commits** add or remove a private string in their diff: 66 with the owner-facing
    audit's patterns, and 58 to 84 depending on the pattern families. The first of them is the
    repository's first commit.
- **The existing GitHub repository is private, and its pull request and issues are not clean.**
  Pull request #1 and issues #2 and #3 contain a private session link, the operator's state roots,
  real internal ticket keys, an internal client document name and paths containing the employer
  name. They would become public with the repository. GitHub also keeps pull-request refs and
  cached objects, so rewriting the branches and force-pushing does not clean it either.
- Branch names contain nothing private, and there are no tags.

**Recommendation: do not flip the existing private repository to public.** Publish into a **new**
public repository, built from local `main` after the fixes in §5, with fresh history:

1. **Recommended: one squashed initial commit**, made under the public identity with no
   `Claude-Session:` trailer. It is the simplest option and leaves nothing behind.
2. **Or `git filter-repo`**, if the history is worth keeping: `--mailmap` to rewrite the
   company-domain address; `--replace-message` to strip the `Claude-Session:` lines and the ticket
   keys and session ids in commit bodies; `--replace-text` with the full literal list from the
   owner-facing audit; and `--invert-paths` for the files §5.2 excludes. Then re-run the sweeps over
   every rewritten blob and message before pushing.

**Operator decision, 2026-10-10: option 1.** The project is published into a new public repository
as one squashed initial commit, made by the orchestrator. The current private repository is renamed
and keeps the full history, so nothing is rewritten or force-pushed.

Either way, the commit SHAs that documents and tests cited (nine were found) would stop resolving,
and the in-tree references to the private repository's issue #2 would dangle or point at the wrong
issue. **Both are reworded on the launch branch.** The issue #2 references now describe the
incident or the fix they meant (`062d9d7`, `48fbbfd`, `95d81a7`, and two that said only "the
issue's" in `b6d7bd7`), and the nine SHAs are gone (`062d9d7`, `48fbbfd`). Pointers into the
unpublished implementation plans were made standalone in the same pass: comments that cited a
plan's task or correction number or the plan's decision ledger now name the module, check, phase or
defect they mean (`bin/` in `062d9d7`, `7baf405`, `80e681b` and `c693264`; `test/` in `f93580b`,
`d916e37`, `67d2faa`, `b654229`, `193ec62`, `1fb7404`, `37f5b21`, `53bf098` and `b3c01cd`), the
documents describe the plans' tasks without numbering them (`95d81a7`), and three references to an
unpublished per-task brief were reworded (`b6d7bd7`). Review-finding labels went the same way in
both their forms: `review M1` and `review finding F1` labels and bare `I1`s (`1fb7404`,
`5250219`), and `C-1`, `C-2`, `I-5`, `I-9`, `M-1` and `M-4` (`b6d7bd7`, `fa86474`) with the
unhyphenated `C1` (`fa86474`). So did the mutation ids (`M9` in `5250219`; `B21` and `B28` in
`fa86474`) and a numbered `Critical 3` (`fa86474`). Mentions of a numbered review or fix round,
such as "fix round 4", stay as history. The privacy sweep's pointer and SHA classes read zero
outside this file. The commits that §5.5 cites as resolving a row exist only in the private
repository's history.

### 1c. Turn on private vulnerability reporting, and never publish conduct reports

`SECURITY.md`, `CODE_OF_CONDUCT.md` and `.github/ISSUE_TEMPLATE/config.yml` send every private
report to GitHub's **Report a vulnerability** form. That form exists only after an owner or
administrator enables it: in the repository's **Settings**, under **Security and quality** →
**Advanced Security**, click **Enable** next to **Private vulnerability reporting**
([GitHub docs](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/configuring-private-vulnerability-reporting-for-a-repository)).
Until it is on, the project has no private channel at all, because neither document offers an
email address.

**Conduct reports arrive as draft security advisories.** The maintainer must never publish one,
and never request a CVE for one. Handle them privately on the advisory thread and close them
without publishing.

### 1d. Licence and copyright holder: resolved

Decided on 2026-10-10 by the operator: the MIT License, with the operator as the copyright holder.
`LICENSE` carries the copyright line (the year 2026 and the operator's own name), and
`package.json` declares `"license": "MIT"`. Ownership is resolved too: the operator confirms that
his employer does not own the code. §2 records both decisions.

### 1e. Secrets: none found; two checks remain

No credential, token, API key, OAuth material, private key or other secret-shaped value was found
in the tree, in any of the 798 historical blobs, in any commit message, or in the private
repository's pull request and issues. The searches covered the usual token prefixes, JWTs, PEM
blocks, `Bearer` headers, password and key assignments, and long hex and base64 strings. The only
token-shaped strings are labelled dummies in the environment-scrub test
(`test/spawn.test.mjs:43-48`).

Done on the launch branch, 2026-10-10:

- `gitleaks` 8.30.1, in directory mode, found no leaks, over both the working tree and the tracked
  tree at `0aa7aec` (11.6 MB). A later run at `92b36c0` was also clean.
- The privacy sweep's gated classes read zero on this branch: company and client names, people,
  the employer email address, the machine name, the owner's home path, token shapes, real ticket
  keys, the real fixture ids and code quoted from the Claude Code bundle, plus an OCR pass over the
  media. Its hand-read classes (email addresses, IP addresses, phone-number shapes, home paths and
  host names) contain only placeholders, public values and pattern false positives.

Two checks remain before launch:

1. Several files record that, during the build, a review agent read the operator's live Claude
   OAuth token into its own session transcript. The token is not in the repository. Confirm that it
   was rotated (or the session logged out) and that the transcript on the operator's machine was
   deleted.
2. Run `trufflehog git` on the squashed repository before it is pushed, and re-run `gitleaks` and
   the privacy sweep over its one commit, message included.

### 1f. Pre-launch checklist

- [x] Settle the licence and the copyright holder: MIT, decided on 2026-10-10, with the copyright
      line in `LICENSE`; the operator confirms that his employer does not own the code (§2).
- [ ] Push local `main`, or publish from it: `origin/main` is 157 commits behind (§1a).
- [ ] Create a **new** public repository. Do not flip the private one (§1b). Decided on 2026-10-10:
      the private repository is renamed and keeps its full history.
- [ ] Build the tree from **local `main`** plus this branch (§1a): apply §5.2, then every must-fix
      row in §5.5, then the should-fix rows. On the launch branch §5.2 and every must-fix row are
      done; the should-fix rows that §5.5 does not mark resolved are still open.
- [x] Regenerate `test/fixtures/limit-rows.json` as synthetic rows, and edit the documents that
      tests read at runtime together with those tests (§5.3). Done in `2063018` and `7a551a2`, with
      the documents in `aa6ccca`. `npm test` ends where it did: every test passing except, on a
      machine with recent Claude Code transcripts, the one environment-dependent token-meter test
      (Appendix B).
- [x] If `docs/superpowers/plans/` or `docs/BACKLOG.md` is excluded, update the links to them in
      `README.md` (*Documents*, and the *Known limitations* bullet that cites the backlog),
      `CHANGELOG.md` and `.github/ISSUE_TEMPLATE/feature_request.yml`. Excluded in `a6857b8`, with
      `research/designs/`; every reference was updated in `ec253d5`.
- [ ] Squash into one initial commit, with no `Claude-Session:` trailers. Decided on 2026-10-10: the
      orchestrator makes the squashed commit in the new public repository (§1b).
- [ ] Run the secret checks in §1e: `gitleaks` and the privacy sweep are done; the token-rotation
      confirmation and `trufflehog` remain.
- [ ] Read the documents in §4, and ask Anthropic if anything is unclear, before promoting unattended
      use or account rotation.
- [x] Decide on the project's name under Anthropic's brand terms (§4). Operator decision,
      2026-10-10: keep the name claude-soma-lite (descriptive use).
- [x] Decide on the name's risk (§4). Operator decision, 2026-10-10: the risk is accepted.
      Revisit the name if Anthropic objects.
- [x] Paraphrase the quoted Claude Code internals (`RUNBOOK.md:659-662` and `994-1010`,
      `bin/lib/spawn.mjs:338`), or get a licensing view before publishing them (§4). Paraphrased in
      `d744f47` (RUNBOOK), `a61ea77` (the rotation spec's §7), `538943e` (`spawn.mjs`), and
      `d376e94` and `7a551a2` (two test comments).
- [ ] Enable private vulnerability reporting on the new repository (§1c). Conduct reports arrive
      as draft security advisories: never publish one, and never request a CVE for one.
- [x] Re-file anything still useful from the private repository's issues as new public issues,
      without the private details. Done: the known issues are filed as GitHub issues #1-#29, and the
      credential-path weakness as a draft security advisory.
- [ ] If the new repository's owner or name differs, update every link that names
      `github.com/techfreakworm/claude-soma-lite`.
- [x] GitHub does not play a video committed to the repository inline in a README, so the README
      embeds an uploaded copy of `docs/media/showcase.mp4` (a user-attachments URL) and links the
      committed MP4 as a fallback.
- [x] `LICENSE`, the licence badge, the README's *License* and *Not affiliated with Anthropic*
      sections, and the licence and sign-off section of `CONTRIBUTING.md` are on this branch.
- [x] Add `"license": "MIT"` to `package.json`, a code follow-up (Appendix B). Done in `c811627`.

## 2. Licence decision record

**Decided on 2026-10-10 by the operator: the MIT License**, with the operator as the copyright
holder, as the copyright line in [`LICENSE`](../LICENSE) states: the year 2026 and the operator's
own name. The decision replaces an earlier recommendation of Apache-2.0.

**Why MIT:**

- **Family consistency.** The parent project,
  [claude-soma](https://github.com/techfreakworm/claude-soma), is MIT-licensed by the same
  maintainer, and claude-soma-lite ports code from it (for example the event payload limits in
  `bin/lib/bus-tools.mjs`). With both projects under MIT, code can move between the two
  repositories in either direction without relicensing, as long as copied code keeps its copyright
  and permission notice, which is MIT's one condition.
- **Outside contributions.** Under Apache-2.0, contributions would arrive under Apache-2.0 (its
  section 5), so moving them into the MIT parent would likely need those contributors' agreement.
- **The patent grant matters little here.** Apache-2.0's main advantage over MIT is its explicit
  patent grant and patent-retaliation clause, which matter little for a small Node.js command-line
  tool with no dependencies.

**The alternative considered** was Apache-2.0, for its explicit patent grant with a retaliation
clause, and for its section 5 rule that contributions come in under the same licence without a
contributor licence agreement.

**Ownership: resolved.** Whether an employer has a claim can depend on the employment agreement,
on how and when the code was written, and on local law; if an employer owned or co-owned the code,
its approval would be needed and the copyright line would normally name it. On 2026-10-10 the
operator confirmed that his employer does not own the code, so the copyright line names the
operator alone.

**Follow-ups:**

- Done: `package.json` declares `"license": "MIT"` (`c811627`) and keeps `"private": true`, which
  only stops `npm publish`; whether to keep that is the operator's call.
- `README.md` carries the licence badge and a *License* section, `CONTRIBUTING.md` accepts
  contributions under MIT (signing off commits is optional), and `CHANGELOG.md` records both.

## 3. Third-party attribution

A sweep for borrowed material found **one** third-party obligation:

- **loop-engineering** (<https://github.com/cobusgreyling/loop-engineering>, MIT). The six loop
  harnesses H1 to H6 (`prompts/harnesses.json`, read by `bin/lib/harness.mjs`) adapt its
  loop-harness registry: the concept, the vocabulary and some field names (the circuit-breaker knobs
  `max_iterations`, `stagnation` and `no_progress`, after the options of upstream's `loop-context`
  tool) follow upstream. No text was copied: a comparison found no shared passages. The upstream
  licence notice, taken verbatim from its `LICENSE` at commit
  `0978edd85966d77703522ca3a7974314db92d5d4`, is in
  [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md), and `README.md` credits it under
  *Acknowledgements*.

Not obligations:

- **claude-soma** is the same maintainer's own MIT project, and `README.md` names it as the parent
  project. The operator is confirmed as the copyright holder of claude-soma-lite (§2), so this
  needs no action.
- **`@modelcontextprotocol/server-sequential-thinking`** is fetched at runtime with `npx` by each
  lead. It is not redistributed.
- **Contributor Covenant 2.1**: `CODE_OF_CONDUCT.md` carries its attribution block.

Two code follow-ups in protected paths (Appendix B): put the attribution where the registry is
defined, and correct `bin/lib/harness.mjs:7-11`, which says the schema is "attributed" and kept
"field-compatible" with the upstream project. Neither holds: nothing in the registry attributes it,
and of the registry's own keys only `name` appears in upstream's registry schema at that commit.
soma's `autonomy` stands where upstream has `week_one_mode`, with different values.

## 4. Policy review before launch

This section reports what Anthropic's published terms and some public sources say. It draws **no
legal conclusion**. Before promoting the features below, the operator should read the current
documents himself, and ask Anthropic if anything is unclear.

**What soma does that these documents touch:**

1. **It runs Claude Code unattended.** A script (the watchdog) starts, supervises and revives
   `claude` sessions in tmux, with permission prompts bypassed and nobody at the panes.
2. **Account rotation moves a lead between separately logged-in Claude Code configurations.** When a
   lead's seat hits a usage limit, the watchdog kills the lead and resumes it under another seat.
   RUNBOOK §7 requires every seat to be in the same Team or Enterprise organisation, and the README
   tells operators to use only accounts or seats they are entitled to use under their plan's terms.

**What Anthropic's documents say (checked 2026-10-10):**

- The [Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) (effective
  October 8, 2025) govern Claude.ai, Claude Pro and other consumer offerings. They say: "You may not
  share your Account login information, Anthropic API key, or Account credentials with anyone else.
  You also may not make your Account available to anyone else." Their list of prohibited uses
  includes: "Except when you are accessing our Services via an Anthropic API Key or where we
  otherwise explicitly permit it, to access the Services through automated or non-human means,
  whether through a bot, script, or otherwise."
- The [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) (effective
  June 17, 2025) govern "Anthropic API keys and any other Anthropic offerings that references these
  Terms", and say "Customer is responsible for all activity under its account." No language
  specific to rotating between seats was found in them.
- The [Usage Policy](https://www.anthropic.com/legal/aup) (when checked, the page was marked
  "Effective November 12, 2026", a future date, and linked the previous version) lists, under *Do Not Abuse Our Platform*: "Coordinate malicious
  activity across multiple accounts, or create multiple accounts, to avoid detection, circumvent
  product guardrails, or generate identical or similar inputs that otherwise violate our Usage
  Policy", and "Resell, proxy, or otherwise provide access to Claude through unauthorized means,
  including services that route requests through consumer subscriptions or misrepresent the product
  or client being used."
- The help-centre article
  [Using Agents According to Our Usage Policy](https://support.claude.com/en/articles/12005017-using-agents-according-to-our-usage-policy)
  (March 16, 2026) lists "Create or manage multiple accounts to evade detection or circumvent
  platform safeguards" among the forms of scaled abuse.
- Anthropic's Claude Code documentation covers scripted and unattended use.
  [Run Claude Code programmatically](https://code.claude.com/docs/en/headless) says of the Agent
  SDK: "It's available as a CLI for scripts and CI/CD", and has a section titled "Turn off
  permission prompts in unattended runs". This audit does not decide whether that documentation is
  the explicit permission the Consumer Terms mention, or how it applies to subscription plans.
- The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says: "Unless
  previously approved, Anthropic does not allow third party developers to offer claude.ai login or
  rate limits for their products, including agents built on the Claude Agent SDK." soma offers no
  login of its own: each lead runs the `claude` CLI that the operator installed, under the
  operator's own login. This audit does not decide how that note applies.

**What others report (secondary and unverified):**

- An article by MetricNexus,
  [Anthropic Is Banning Users With Multiple Claude Accounts: What We Know](https://metricnexus.ai/blog/anthropic-banning-multiple-claude-accounts)
  (February 26, 2026), reports users with several Max subscriptions losing access in February 2026.
  It also quotes an Anthropic employee saying that having multiple Max accounts is not against the
  terms.
- The README of [claude-rotate](https://github.com/doxaras/claude-rotate), a third-party rotation
  tool, says: "Rotating accounts to work past limits is a gray area under Anthropic's consumer
  terms". That tool switches between consumer accounts "you personally own and pay for", while
  soma's seats are meant to be seats in one Team or Enterprise organisation (RUNBOOK §7).

**Recommendation:** before promoting account rotation, or unattended fleets on subscription plans,
check the current Consumer Terms, Commercial Terms (or whatever agreement covers the plan in use)
and Usage Policy for (1) rotating work between several seats or accounts and (2) unattended,
automated operation on subscription plans.

**The project's name and Anthropic's marks.** The Consumer Terms (section 12, *General terms*)
say: "Use of our brand. You may not, without our prior written permission, use our name, logos, or
other trademarks in connection with products or services other than the Services, or in any other
way that implies our affiliation, endorsement, or sponsorship." The *Branding guidelines* in the
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), written for partners that
build on the Agent SDK, do not permit "Claude Code" or "Claude Code Agent" as a name, and say: "Your
product should maintain its own branding and not appear to be Claude Code or any Anthropic
product." The project's own name contains "claude". **Operator decision, 2026-10-10: keep the
name claude-soma-lite (descriptive use).** The README and `THIRD_PARTY_NOTICES.md` say that the
project is independent and not affiliated with Anthropic, that its name refers to the software it
works with, descriptively and not as a claim of affiliation, and that it otherwise names Claude and
Claude Code only to say what the tool works with, never as a logo. **Operator decision,
2026-10-10: the risk is accepted.** This audit does not decide whether the name needs Anthropic's
permission under the clause above; the operator keeps the name knowing that, and will revisit it if
Anthropic objects. The showcase video and GIF use an
abstract glyph and a neutral chat panel, with no Anthropic or Claude artwork, no logo and no copy of
the Claude Code interface, which is consistent with that notice.

**Quoted Claude Code internals.** Both sets of terms restrict reverse engineering: the Consumer
Terms prohibit attempts "To decompile, reverse engineer, disassemble, or otherwise reduce our
Services to human-readable form", except where the law prohibits that restriction, and the
Commercial Terms say a customer must not "reverse engineer or duplicate the Services". At
`9ca4293` some files quoted identifiers and code read out of the minified Claude Code bundle:
`RUNBOOK.md:659-662` (the command table) and `RUNBOOK.md:994-1010` (settings and gating functions),
and `bin/lib/spawn.mjs:338` (a settings loader). `bin/lib/settings-gen.mjs:495` describes the
binary's behaviour without quoting it. **Resolved on the launch branch:** the three quoting
passages, the rotation spec's §7 step 1 (which quoted the same command table) and two test comments
now describe the observed behaviour in prose (`d744f47`, `a61ea77`, `538943e`, `d376e94`,
`7a551a2`), and the privacy sweep's check for quoted bundle code reads zero.

## 5. Findings

### 5.1 Summary

319 findings. A finding is one literal pattern in one file; repeats in the same file are grouped.
301 come from the owner-facing audit, and 18 were added to cover every line flagged by an
independent census. Most of those 18 are placeholders and false positives, recorded so that no
flagged line goes unexplained.

| category | must-fix | should-fix | ok-to-keep | total |
|---|---|---|---|---|
| company | 33 | 5 | 0 | 38 |
| ticket/repo | 29 | 28 | 5 | 62 |
| person | 2 | 1 | 4 | 7 |
| id/session/transcript | 4 | 16 | 3 | 23 |
| local-env | 1 | 88 | 23 | 112 |
| secret | 0 | 0 | 7 | 7 |
| ops-data | 2 | 61 | 4 | 67 |
| (clean-file notes) | 0 | 0 | 3 | 3 |
| **all** | **71** | **199** | **49** | **319** |

**Severity:**

- **must-fix**: names the employer, a client, a client product or an internal system; names a real
  third party; carries a real internal ticket key or sprint; quotes client work; is a path containing
  the employer name; states a fact about the employer's environment; or is a credential or a real
  account or organisation id.
- **should-fix**: real but generic. Operational identifiers (session ids, a real reset timestamp),
  statistics measured on the operator's fleet, the owner's username or machine name, home paths
  without the employer name, the operator's config-directory, socket and wrapper names, personal MCP
  servers and connectors, ticket keys used only as format examples, real pane titles, and references
  into the private issue tracker.
- **ok-to-keep**: placeholders, public references, generic product names, labelled dummies, and
  pattern-sweep false positives.

Twenty-five tracked files have no findings at all, among them the three hooks other than the gate,
`bin/soma-pr.mjs`, `skills/soma-promote/SKILL.md` and `prompts/harnesses.json`.

**Status on the launch branch (2026-10-10).** Each row in §5.5 that the branch resolved ends its
severity cell with `resolved in <commit>`, `partly resolved in <commit>` (and what remains), or
`resolved: file removed in <commit>`; each mark was checked against the line at the branch's head.

| severity | resolved | partly resolved | open | total |
|---|---|---|---|---|
| must-fix | 71 (22 by removing the file) | 0 | 0 | 71 |
| should-fix | 117 (38 by removing the file) | 7 | 75 | 199 |

Four of the 75 open should-fix rows, the `README.md` rows in §5.5.1, were already fixed by the earlier
README rewrite (§5.4) and say so in their suggested-fix column. The ok-to-keep rows are unchanged
apart from two notes, on `package.json` and on `bin/lib/seats-summary.mjs:31`; the ones in removed
files are moot.

### 5.2 Whole files to exclude or rewrite

Some files are internal by nature and are better left out of the public tree, or rewritten, than
patched line by line.

1. **`docs/superpowers/plans/2026-09-16-account-rotation.md`: exclude.** At 13,542 lines it is an
   implementation diary: test-driven steps, mutation scripts, pasted output and review jargon. It
   carries paths containing the employer name (35 lines), the operator's exact Node build (about 40), an
   inlined copy of the real limit-row fixture (13 session ids, 4 subagent ids), a real reset
   timestamp (about 70 lines) and the operator's time zone (14), the operator's seat and config
   directories (about 65), personal MCP server names, a real ticket key, the operator's wrapper name, and
   citations of gitignored internal reports. It is of no use to outside readers.
2. **`docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md`: exclude** with the rest of
   `plans/`, or trim it to the plan itself. A client repository is its test data, and its correction
   blocks are diary entries full of real measurements.
3. **`research/designs/` (all five files): exclude.** This is the internal design bake-off. Every
   running example is a real ticket on a client repository, and the files cite the internal Jira
   project, real ticket keys, where the employer's API keys live, and credentials the operator holds.
4. **`research/01` to `research/04`: keep, patched.** 01: delete line 5 (it is otherwise a reading of
   the public claude-soma repository). 02: lines 211, 216, 239, 255 and 280. 03: lines 9, 66-76, 120,
   136, 156 and 190-194, or exclude the file. 04: line 57.
5. **`docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md`: rewrite the examples.** The
   design is generic and worth publishing, but every worked example in §1, §4, §7, §12, §13 and §14 is
   built on a path containing the employer name, the client repository and real ticket keys. One
   global substitution plus edits to lines 13, 183, 241, 271 and 277 fixes it.
6. **`docs/superpowers/specs/2026-09-15-account-rotation-design.md`: rewrite §1, §7 and the last
   bullet of §9** with invented evidence, or exclude it. Those sections rest on the employer
   organisation's real spend-cap events, a real ticket key, the real reset histogram, a backup path
   containing the employer name, and the operator's time zone, wrapper name and seat directories.
7. **`docs/BACKLOG.md`: rewrite or exclude.** It is an operations backlog written from the
   operator's live machine. Moving its items into public issues is the cleaner option.
8. **`test/fixtures/limit-rows.json`: regenerate as synthetic rows.** Every row is real: 17 real
   transcript ids, real timestamps, reset times and Claude Code builds, the employer organisation's
   spend-cap timeline, and a provenance line naming the operator's config directory and a gitignored
   report. Keep the shapes. Update `test/limit-state.test.mjs:16,54`, the users of `realRow()` in
   `test/watchdog.tick.test.mjs`, and the real reset timestamp that is hard-coded in about 16 files,
   including `bin/lib/wd/limit-state.mjs`.
9. **Keep with line fixes:** `README.md` (done on this branch), `RUNBOOK.md`, `docs/ROADMAP.md`
   (lines 101-113, 197 and 201), `prompts/`, `skills/`, all of `bin/` and the remaining tests. In
   `bin/`, the only must-fix items are `bin/lib/wd/pane-state.mjs:61,63,143` and
   `bin/lib/settings-gen.mjs:583`; the rest is should-fix wording. In the tests, the must-fix items
   are mechanical renames of client repository and product names, plus replacing a verbatim screen
   capture from a client-work session and a client-work pane title.
10. **Keep `.superpowers/` gitignored, and remove every tracked citation of it**: `RUNBOOK.md:948-954`,
    the fixture's provenance line, both plans and the rotation spec. Those reports hold real
    measurements, and one of them holds a seat's login email address.

Status on the launch branch: items 1, 2, 3 and 7 are done, the files removed in `a6857b8` and every
reference to them updated in `ec253d5`. Item 4 is done for the must-fix lines (`e2df5c6`); the other
lines it names stay open as marked in §5.5.5. Item 5 is done in `90a0c72`, except lines 183, 241
and 271. Item 6 is done in `a61ea77`, with the fixture wording in `aa6ccca`. Item 8 is done in
`2063018` and `7a551a2`. Item 9: every must-fix line in those files is fixed, and the should-fix
lines are as §5.5 marks them. Item 10 is done: `RUNBOOK.md` in `fd72a5a`, the fixture in `2063018`,
the rotation spec in `a61ea77`, both plans removed, and the two test comments that cited the reports
in `2063018` and `bfb4fef`; `.gitignore` is the only tracked file that names the directory.

### 5.3 Documents that tests read at runtime

Several tests read `RUNBOOK.md`, `README.md` and the rotation spec, and anchor on exact phrases:
`test/cli.test.mjs`, `test/doctor.test.mjs` and `test/settings-gen.test.mjs`. Edit those documents
together with their tests, and run `npm test` after each edit. For example, `README.md` must keep the
phrase `claude auth login`, must never spell `claude login`, and must not carry the provenance
sentence that only `RUNBOOK.md` and the rotation spec may carry. `RUNBOOK.md` §11.3 is pinned by
`test/settings-gen.test.mjs`.

### 5.4 Already fixed on this branch

- **`README.md` was rewritten** as the public front page. The README rows in §5.5.1 refer to the
  README at `9ca4293`. The rewrite uses neutral names for the second-profile example, drops the
  fleet statistics and the private-tracker reference, states the tmux-continuum case as a
  condition, describes MCP servers generically, and no longer quotes the corpus size or a specific
  Node build.
- **New files on this branch** (`CODE_OF_CONDUCT.md`, `SECURITY.md`, `CONTRIBUTING.md`,
  `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, `.github/`, `docs/install/`, `docs/media/` and this
  file) were scanned for the same pattern families, with no hits. `CHANGELOG.md` was written fresh
  from the commit history; it copies no commit SHA, author, session link or ticket key.
- **`LICENSE` (MIT) and the trademark notice** are on this branch (§1d, §2 and §4).
- Security and conduct reports go through GitHub's private vulnerability reporting, never an email
  address (§1c).
- **The launch branch (`soma/soma-lite-launch`)** resolves every must-fix finding and many
  should-fix ones, and §5.5 marks each row it resolved (§5.1).

### 5.5 Findings by file

Columns: where (file and line numbers at `9ca4293`), the category, what was found, described rather
than quoted, the suggested fix, and the severity, followed by the row's status on the launch branch
when it is resolved or partly resolved (§5.1).

#### 5.5.1 Root files

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| README.md:3 | person | owner's GitHub handle; links the PUBLIC sibling repo | keep if publishing under the same account | ok-to-keep |
| README.md:64,68-73 | local-env | the second-profile example is the operator's real setup, and the wrapper name likely abbreviates the employer name | fixed on this branch: a neutral `soma2()` wrapper with `~/.claude-second`, `~/.soma-second` and its own tmux socket | should-fix |
| README.md:252,254 | ops-data | operator fleet stat, plus a reference into the private tracker | fixed on this branch: the fleet figures and the tracker reference are gone | should-fix |
| README.md:275 | local-env | states the operator's tmux-resurrect/continuum setup as fact | fixed on this branch: stated as a condition ("if your `~/.tmux.conf` loads …") | should-fix |
| README.md:309 | local-env | reveals the operator's personal MCP set | fixed on this branch: generic wording | should-fix |
| README.md:134-135 | ops-data | anonymous corpus size | fixed on this branch: the corpus size is no longer quoted | ok-to-keep |
| README.md:50 | local-env | generic `SOMA_NODE_DIR` example | fixed on this branch: `v24.x.y` | ok-to-keep |
| RUNBOOK.md:164,668,672,678,679,686,700,710,716 | local-env | the seat-pool example and every provisioning step use the operator's real seat dir | `~/.claude-seat-2` or `<seat-dir>` | should-fix |
| RUNBOOK.md:676,678,701,710,929 | local-env | the operator's work-profile root, presented as the shared tree | `<fleet config root>/projects`; drop "work fleet" | should-fix |
| RUNBOOK.md:658 | local-env | the operator's wrapper name | neutral name; drop "work-profile" | should-fix, resolved in `d744f47` |
| RUNBOOK.md:523,525 | ticket/repo | the enqueue example uses a real ticket key | a neutral id such as `proj-42`; check the example title does not mirror the real ticket | should-fix, resolved in `fd72a5a` |
| RUNBOOK.md:813-818 | ticket/repo | peek/send/attach/kill/resume/retry CLI examples | `task-42` | should-fix, resolved in `fd72a5a` |
| RUNBOOK.md:277,877,900 | ticket/repo | private-tracker reference | describe the issue inline | should-fix, resolved in `95d81a7` |
| RUNBOOK.md:280-281,877,900 | ops-data | stall stats from the operator's fleet | generalise | should-fix |
| RUNBOOK.md:422-424 | ops-data | implies the operator's lifetime usage | drop the percentages | should-fix |
| RUNBOOK.md:948-949,954 | local-env | cites a gitignored report measured on real seats (plan:13342 says the login email is in it) | drop the citation, or ship a cleaned summary | should-fix, resolved in `fd72a5a` |
| RUNBOOK.md:955-956 | ops-data | label for a real limit event (a five-hour reset in late August) in the fixture | rename when the fixture is regenerated | should-fix, resolved in `fd72a5a` |
| RUNBOOK.md:1022,1034-1035 | ops-data | anonymous corpus stats | keep or round | ok-to-keep |
| RUNBOOK.md:1147-1148 | secret | incident narrative, no token value | keep; confirm the token was rotated (§1e) | ok-to-keep |
| package.json:1-9 | — | no personal data (the `license` field it lacked was added in `c811627`) | keep | ok-to-keep |
| .gitignore:1-4 | — | keeps the internal reports and scratch out of git | keep | ok-to-keep |
| RUNBOOK.md:145 | local-env | a placeholder home path in the `soma.json` example, matched by a pattern sweep | keep, or use `/path/to/myapp` | ok-to-keep |

#### 5.5.2 `prompts/` and `skills/`

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| prompts/lead.md:40-41 | ops-data | a standing order sent to every lead quotes fleet stall statistics, and `test/prompts.test.mjs:198` pins the figure | "measured: sessions stalled for hours", and update the pin in the same edit | should-fix |
| prompts/orchestrator.md:36 | ticket/repo | id-format example ("Keep ids short, lowercase and stable") | `task-42` | should-fix, resolved in `e2df5c6` |
| prompts/orchestrator.md:68 | ops-data | dated anecdote from the operator's fleet | keep the rule, drop the dated anecdote | should-fix |

#### 5.5.3 `bin/` (shipped code)

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| bin/lib/wd/pane-state.mjs:61 | ticket/repo | the live client-work lead (client work, a real ticket key) named as fixture provenance | "(live lead, 2.1.263)" | must-fix, resolved in `015d66d` |
| bin/lib/wd/pane-state.mjs:63,143 | ticket/repo | real lead name in the composer top-rule example | "──── lead-task-1 ─" (change test/pane-state.test.mjs to match) | must-fix, resolved in `015d66d` |
| bin/lib/wd/pane-state.mjs:63 | local-env | the operator's orchestrator session name (named after the employer) | keep only `soma-orch` | should-fix, resolved in `015d66d` |
| bin/lib/wd/pane-state.mjs:7-9,47,63-64,142 | ops-data | fleet anecdotes | generic wording | should-fix |
| bin/lib/wd/pane-state.mjs:34-35,66 | id/session/transcript | captured live status line with no work content | keep | ok-to-keep |
| bin/lib/settings-gen.mjs:579-583 | ticket/repo | a real ticket tied to a lead that stalled after an organisation spend cap, plus a local-time tell | "(measured: a rate-limited lead sat silent for days)"; "`continuing automatically at <time>`" | must-fix, resolved in `015d66d` |
| bin/lib/settings-gen.mjs:222,301,316 | local-env | operator config root | `$CLAUDE_CONFIG_DIR/…` | should-fix |
| bin/lib/settings-gen.mjs:41-42,293,313,891-892 | local-env | the operator's personal MCP servers | hypothetical wording ("e.g. servers with real-world side effects, such as writing a database") | should-fix |
| bin/lib/settings-gen.mjs:43-44,322-324,888-891 | local-env | the operator's claude.ai connectors and their auth state | "account connectors may already be authenticated" | should-fix |
| bin/lib/settings-gen.mjs:317-318,572,1135-1137 | ops-data | counts from the operator's environment and fleet | drop the counts | should-fix |
| bin/lib/settings-gen.mjs:24 | id/session/transcript | session-id fragment from a live teammate probe | `<team>@session-<id>` | should-fix, resolved in `ea4dc62` |
| bin/lib/settings-gen.mjs:457-458,822,1058 | local-env | operator use case, gh token scope, environment | generic wording | should-fix |
| bin/lib/settings-gen.mjs:654-656,744,1007-1008 | secret | incident narrative, no value | keep or make hypothetical; confirm rotation (§1e) | ok-to-keep |
| bin/lib/bus-tools.mjs:904,905,907 | id/session/transcript | "Measured on Claude Code 2.1.220": real session ids in a comment table | `<session-A>` / `<parent-session-B>` | should-fix, resolved in `ea4dc62` |
| bin/lib/bus-tools.mjs:219,1218,1452 | ticket/repo | 1218 and 1452 are user-facing refusals | `task-42` | should-fix, resolved in `4a74bde` |
| bin/lib/bus-tools.mjs:288,650,1741 | ticket/repo | private-tracker reference | drop the number | should-fix, resolved in `062d9d7` |
| bin/lib/doctor.mjs:248 | local-env | CREDENTIAL_VECTORS entry uses the operator's config dir | `~/.claude-second/.credentials.json` (also test/settings-gen.test.mjs:832) | should-fix |
| bin/lib/doctor.mjs:235 | local-env | credential deny vector; may mirror the operator's `pass` layout | `pass show x/aws` (also test/settings-gen.test.mjs:822) | should-fix |
| bin/lib/doctor.mjs:444-445,648,1962,1964 | ops-data | line 648 ships in doctor's FAIL output | "left unattended leads stalled for days" | should-fix |
| bin/lib/doctor.mjs:1162-1164 | local-env | the operator's account inventory | generic wording | should-fix |
| bin/lib/doctor.mjs:1274,1573 | local-env | operator machine and fleet facts | generic wording | should-fix |
| bin/lib/doctor.mjs:439,635,1962 | ticket/repo | private-tracker reference | drop the number | should-fix, resolved in `062d9d7` |
| bin/soma.mjs:673,1523 | ticket/repo | user-facing CLI strings | `task-42` | should-fix, resolved in `4a74bde` |
| bin/soma.mjs:1197 | local-env | user-facing `init --seat` hint names the operator's seat dir | `--seat /path/to/seat` | should-fix |
| bin/soma.mjs:1298-1299,1306,1402 | local-env | operator's two-profile setup | generic wording | should-fix |
| bin/soma.mjs:1317-1321 | local-env | operator's tmux sockets | "two fleets on sockets `soma` and `soma_second`" | should-fix |
| bin/soma.mjs:822-823,1049-1050 | ops-data | fleet anecdote and operator decision | generic wording | should-fix |
| bin/soma.mjs:229,821,1535 | ticket/repo | private-tracker reference | drop the number | should-fix, resolved in `062d9d7` |
| bin/soma-bus.mjs:521,589 | ticket/repo | MCP tools/list schema text that every model sees at runtime | `task-42` / `PROJ-42` | should-fix, resolved in `4a74bde` |
| bin/soma-bus.mjs:318 | ticket/repo | private-tracker reference | drop the number | should-fix, resolved in `062d9d7` |
| bin/soma-watchdog.mjs:15,504-505 | ops-data | real incident | "stuck for days" | should-fix |
| bin/soma-watchdog.mjs:58-61,1030-1033 | ops-data | measured on the operator's real lead directory | generic wording | should-fix |
| bin/soma-watchdog.mjs:65,757 | ops-data | from one of the operator's transcripts | "orders of magnitude apart" | should-fix |
| bin/soma-watchdog.mjs:1634 | ops-data | count of the employer org's spend-cap rows | "the org cap carries no reset time" | should-fix |
| bin/hooks/lead-gate.mjs:478-479 | local-env | names the operator's personal MCP and connectors | reuse the generic wording of lines 28-29 | should-fix |
| bin/hooks/lead-gate.mjs:1064-1067,1076,1093,1097,1099,1944 | ops-data | stats mined from the operator's fleet | "observed: multi-hour stalls" | should-fix |
| bin/hooks/lead-gate.mjs:1756 | ops-data | CD_COMPOUND_DENY, shown verbatim to every model | "can sit on that prompt indefinitely" | should-fix |
| bin/hooks/lead-gate.mjs:1058 | ticket/repo | private-tracker reference | drop the number | should-fix, resolved in `062d9d7` |
| bin/lib/spawn.mjs:372-374 | id/session/transcript | teammate argv from a live probe | `<uuid>` | should-fix, resolved in `ea4dc62` |
| bin/lib/spawn.mjs:896-897 | ops-data | fleet count and tracker reference | generic wording | should-fix, partly resolved in `062d9d7`; the fleet count remains |
| bin/lib/spawn.mjs:16-17,71-82,96,170,535-536 | local-env | operator's settings and machine layout | "on a machine where CLAUDE_CONFIG_DIR is set …" | should-fix |
| bin/lib/tokens.mjs:52-54,75-76,96,111,136-138,143,208,308-309 | ops-data | corpus counts attributed to the operator (143 is a runtime string) | keep the ratios; drop "operator's" and the absolute counts | should-fix |
| bin/lib/tokens.mjs:11-12,281 | local-env | operator machine layout; a fragment of a real cwd | generic wording; `a_b` → `a-b` | should-fix |
| bin/lib/canary.mjs:107-113,139-140,200-202,210-212,234 | local-env | the operator's personal MCP servers, connectors and plugin | "account connectors (mail, chat, cloud drive) may already be authenticated" | should-fix |
| bin/lib/canary.mjs:330-331 | ops-data | fleet stats | generic wording | should-fix |
| bin/lib/seats.mjs:21-23,43,254-256,422-423 | ops-data | real-row stats and the operator's preference | generic wording | should-fix |
| bin/lib/pretrust.mjs:11-12,64-65 | local-env | operator machine fact | "CLAUDE_CONFIG_DIR is often set" | should-fix |
| bin/lib/pretrust.mjs:34,142; bin/soma-bus.mjs:110 | local-env | trivial machine facts | keep | ok-to-keep |
| bin/lib/tmux.mjs:21-26 | local-env | the operator's own work and personal fleets | "an operator running two fleets on two sockets" | should-fix |
| bin/lib/tmux.mjs:208-209; bin/lib/wd/reconcile.mjs:8 | ops-data | real incident plus a private-tracker reference | "a lead can sit as a bare shell after a restore"; drop the issue number | should-fix, partly resolved in `062d9d7`; the incident in `tmux.mjs` remains |
| bin/lib/lease.mjs:197-205 | ops-data | the operator's own incident, with a real pane id | make it hypothetical ("a dead `%N`") | should-fix |
| bin/lib/wd/backpressure.mjs:16-18 | ops-data | describes the real work backlog | "a fleet may be working tickets about HTTP 429 handling" | should-fix |
| bin/lib/wd/budget.mjs:43-48,150-152; bin/lib/wd/revive.mjs:21-29,56-57 | ops-data | readings from the operator's sessions | rounded or relative figures ("~120M vs ~600k", "most resumes") | should-fix |
| bin/lib/config.mjs:61-83,107-152 | ops-data | calibration stats from the operator's real ticket work | keep the chosen caps; describe the sample generically | should-fix |
| bin/lib/config.mjs:283 | ops-data | text of the LEGACY_KEYS stderr warning shown to users | "(two orders of magnitude apart)" | should-fix |
| bin/lib/wd/limit-state.mjs:8-9,26-30,47-48 | ops-data | shows the employer org was at its spend cap | "rows can carry both a window type and a cap reason" | should-fix, resolved in `2063018` |
| bin/lib/wd/limit-state.mjs:71,74,84 | ops-data | the real reset time from the operator's account, also shown in local time | an invented epoch (e.g. 1800000000); drop "Event A" | should-fix, resolved in `2063018` |
| bin/lib/paths.mjs:100-103 | local-env | names the operator's live CLAUDE_CONFIG_DIR | "nor `<previous config dir>/projects`" | should-fix |
| bin/lib/standing.mjs:130-134 | ops-data | fleet stats | "on roughly a third of Bash calls" | should-fix |
| bin/lib/wd/rotation-events.mjs:159 | ops-data | count of the org's cap rows | "(on every spend-cap row observed)" | should-fix |
| bin/lib/seats-summary.mjs:38 | local-env | the half-hour offset in a rendered time reveals the operator's time zone | a whole-hour or UTC rendering | should-fix, resolved in `81a4daa` |
| bin/lib/seats-summary.mjs:31 | ops-data | Event A's reset as the pane shows it | keep, or change it along with Event A | ok-to-keep, changed to a UTC rendering in `bc426cb` |
| bin/lib/doctor.mjs:240,252 | local-env | placeholder home paths inside synthetic credential test vectors | keep | ok-to-keep |
| bin/lib/settings-gen.mjs:1119; bin/lib/spawn.mjs:88; bin/soma.mjs:1981 | local-env | placeholder home paths in comments | keep | ok-to-keep |
| bin/lib/filelock.mjs:432 | ticket/repo | a file-mode word that matches the ticket-key pattern (a false positive) | keep | ok-to-keep |

#### 5.5.4 `docs/`

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| docs/superpowers/plans/2026-09-16-account-rotation.md:112,118,341,863,1159,2253,3002,3968,4242,4849,5043,5253,5258,7607,7612,10562,10665,10943,11002,11113,11187,11284,11402,11515,11676,11706,11733,11789,12156,12774,12823,12897,13011,13120 | company | employer name plus the owner's username in the repo root | "run from the repo root" / `<repo>/…` | must-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:27 | company | employer path plus the operator's fleet layout | "the main checkout"; drop the live-fleets clause | must-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:2841,2888 | ticket/repo | real ticket tied to a real stalled lead; the comment the plan adds to settings-gen | "measured on one stalled lead" | must-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:126-190 | ops-data | the employer org's spend-cap and auth history | synthetic rows | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:133-190,222,256 | id/session/transcript | real transcript file:line references | `s01.jsonl:218` etc. | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:100,221,223,254,487,8145,8149,8151 | id/session/transcript | short session ids; Event A and Event C provenance | keep only the labels "Event A/C" | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:137,144,145,146 | id/session/transcript | real subagent transcript ids | `agent-1.jsonl` … | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:126,130 | local-env | fixture provenance from the operator's transcripts | "a local transcript corpus" | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:21,107,126,130,487,579,12886,13342,13348 | local-env | cites gitignored internal reports (one holds the seat login email) | drop the citations | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md (72 lines, e.g. 100-101,109,225,247,251,288,300-302,503-545,618,628,760,794,1028-1031,3936,4043-4154,4349,4501-4724,4891,4963,5071,5202-5231,5669,5707,5927,5981-5982,6146-6153,6558-6586,6866-7300,8147,8160,8309,8765,11141) | ops-data | the real five-hour reset (Event A, a late-August date) used as the test clock | an invented round epoch | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:101,317,319,462,500,1029,2886,3936,4149,4171-4173,4341,4349,5927,5981,8147 | local-env | the operator's time zone (a UTC reset rendered as local time) | a neutral zone; drop the local-time rendering | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:5411,9438 | ops-data | count of the org's real cap rows | drop the count | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:8142,8153,10546,10596-10600 | ops-data | points at the real-row fixture | reword once the fixture is synthetic | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:5118,5121,5122,5130,5131,5138,5139 | ticket/repo | lead id in ROTATED / ROTATION_FAILED fixtures | `task-7` | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:3406,3460,12396,12398,12573,12612 | local-env | the operator's personal MCP server names | `personal_srv` | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:888,890,1045,1058,1059,1114,1115,2161,2306,2347,2360,2508,2531,2764,2805,2806,4727-4729,11850-12580 (≈22 lines),11934,13229-13258,13395 | local-env | copies the operator's real seat-dir naming in tests, RUNBOOK and help text | `~/seat-b` etc. (same rename repo-wide) | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:2276,2282,2327,2338,2360,2361,2531,2762,2764,2805,2806,13237,13239,13253,13323, and the fixtures in lines 11850 to 12580 | local-env | the operator's work config root | a placeholder home path | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:15,112,117,857,864,2252,3001,3157,3293,3324,3500,3604,3613,3749,3871,3882,3914,3924,3967,5042,5252,5882,5929,7607,10562,10665,10735,10943,10997,11002,11113,11187,11284,11402,11515,11676,11706,11733,11790,12896 | local-env | the operator's exact nvm build in every Run step | "Node ≥ 24 on PATH" once, as a prerequisite | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:13221 | local-env | the operator's wrapper | `soma2` | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:2334-2335,2382 | local-env | operator machine | "on a machine whose ~/.claude is stale" | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:13497 | local-env | plan tier (also in ROADMAP:170, spec:203) | keep | ok-to-keep |
| docs/superpowers/plans/2026-09-16-account-rotation.md:30,464,781,961,1342,1989,2137,2177,2466,2713,2824,2967,3312,3648,3908,4033,4125,4351,4406,4482,4624,4707,4841,4948,5457,5612,5731,5874,6100,6266,6336,6520,6639,6848,6941,7041,7215,7423,7577,7853,8133,8684,8964,9257,9356,9460,9554,9651,9796,10213,10477,10968,11049,11156,11214,11347,11443,11598,11727,12148,12765,13056,13432,13538 | — | assistant co-author trailers (a public no-reply address) in the plan text; no session links | keep | ok-to-keep |
| docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md:448,1479,1495,1499 | company | client repo as test data | `repo: 'myapp'` | must-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md:1648,1650,1659,1661,1662,1811 | local-env | the operator's personal and DB MCP servers | `example-a`, `example-db` | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md:2729 | ops-data | the operator's lifetime usage share | "the worst case is large" | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md:2559,2568 | ops-data | real usage numbers | keep the rule, drop the counts | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md:2843 | local-env | operator account surface | "account-side connectors exist without local config" | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-07-29-claude-soma-lite-v1.md:2844 | secret | incident narrative, no value | keep; confirm rotation | ok-to-keep |
| docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md:131,136,137,138,139,141,144 | company | the spawn recipe is built on the employer path, client repo and a real ticket | `~/code/myapp`, `task-1` | must-fix, resolved in `90a0c72` |
| docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md:151,155,157,166,170,171,174,175,176,177,179 | ticket/repo | the full tmux/claude spawn command (client repo at 155) | global replace with `task-1` / `myapp` | must-fix, resolved in `90a0c72` |
| docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md:82,83,125,285,287,295 | ticket/repo | real ticket keys in the diagram and UX examples | `task-1`, `task-2` | must-fix, resolved in `90a0c72` |
| docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md:277 | ticket/repo | names the employer's real Jira project | delete the parenthetical | must-fix, resolved in `90a0c72` |
| docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md:13 | ticket/repo | Jira project key | "10 backlog tickets" | should-fix, resolved in `90a0c72` |
| docs/superpowers/specs/2026-07-29-claude-soma-lite-design.md:183,241,271 | local-env | operator vendor accounts, personal MCPs and backlog | generic wording | should-fix |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:11 | company | employer path; backup location of the internal reports | delete the clause | must-fix, resolved in `a61ea77` |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:29 | ticket/repo | real ticket plus the employer org's spend-cap event | "a lead sat ~6 days after an org cap" | must-fix, resolved in `a61ea77` |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:20,71,210 | ops-data | real reset-time histogram | invented epochs; describe the shape only | should-fix, resolved in `a61ea77` |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:23,91,95 | ops-data | counts of the employer org's real cap hits | keep the schema facts, drop the real counts | should-fix, partly resolved in `a61ea77`, `aa6ccca`; the real row count on line 91 remains |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:25,33 | local-env | the operator's timezone | `(UTC)` / a neutral time | should-fix, resolved in `a61ea77` |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:70,191,192,193,194,195 | local-env | seat dirs, work root and wrapper | `<seat-dir>`, `soma` | should-fix, partly resolved in `a61ea77`; the seat-directory name in the line-70 example remains |
| docs/superpowers/specs/2026-09-15-account-rotation-design.md:203,209 | local-env | plan tier; a pointer (no email disclosed) | keep | ok-to-keep |
| docs/ROADMAP.md:101-113 | local-env | the security posture of the operator's machine | rewrite as general guidance | should-fix |
| docs/ROADMAP.md:201 | ops-data | the operator's lifetime usage | drop the percentages | should-fix |
| docs/ROADMAP.md:61 | ticket/repo | private-tracker reference | describe inline | should-fix, resolved in `95d81a7` |
| docs/ROADMAP.md:197 | secret | incident narrative, no value | keep; confirm rotation | ok-to-keep |
| docs/ROADMAP.md:170 | local-env | plan tier | keep | ok-to-keep |
| docs/BACKLOG.md:188-192 | local-env | the "Ops notes" section about the operator's machine | delete the section | should-fix, resolved: file removed in `a6857b8` |
| docs/BACKLOG.md:45-51,83,132 | local-env | the operator's live machine state | "a retired state root" | should-fix, resolved: file removed in `a6857b8` |
| docs/BACKLOG.md:21 | ticket/repo | private-tracker reference | describe inline | should-fix, resolved: file removed in `a6857b8` |
| docs/BACKLOG.md:53,175 | ticket/repo | backlog item cross-references that match the key pattern (false positives) | keep | ok-to-keep |
| docs/superpowers/plans/2026-09-16-account-rotation.md:330 | ops-data | the real reset timestamp in a test step | goes with the exclusion of the whole file | should-fix, resolved: file removed in `a6857b8` |
| docs/superpowers/plans/2026-09-16-account-rotation.md:2341,2731,3079,3442,3452,3518,4012,4814,9911 | local-env | placeholder home paths and ids, and test-count arithmetic that matches the key pattern (false positives) | goes with the exclusion of the whole file | ok-to-keep |

#### 5.5.5 `research/`

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| research/01-claude-soma-internals.md:5 | company | local clone path: employer name, username, a local uid and a real session UUID | "a local shallow clone" | must-fix, resolved in `e2df5c6` |
| research/01-claude-soma-internals.md:3 | person | source repo (PUBLIC, same owner) | keep | ok-to-keep |
| research/01-claude-soma-internals.md:27-36,68,120-156,227-232,265,359-363,400,448-449,475,502,568-573,712-732 | local-env | facts copied from the PUBLIC claude-soma repo; placeholder IP, env-var reference only | keep (confirm they are all in the public repo) | ok-to-keep |
| research/02-loop-engineering.md:216 | person | a colleague's name plus a real ticket | "e.g. a Stop-hook verify gate" | must-fix, resolved in `e2df5c6` |
| research/02-loop-engineering.md:255,280 | ticket/repo | real ticket used as a named pattern (work content) | "a reserve-before budget pattern" | must-fix, resolved in `e2df5c6` |
| research/02-loop-engineering.md:211,239 | ops-data | real backlog detail | delete or generalise | should-fix |
| research/02-loop-engineering.md:3,29,267 | person | public upstream author and public figures | keep as attribution | ok-to-keep |
| research/03-claude-code-capabilities.md:156 | company | the client-named skill cited as the "real example" | `~/.claude/skills/<name>/SKILL.md` | must-fix, resolved in `e2df5c6` |
| research/03-claude-code-capabilities.md:136 | person | a colleague's name | "the verify-gate pattern" | must-fix, resolved in `e2df5c6` |
| research/03-claude-code-capabilities.md:193 | company | employer path plus the operator's MCP servers | delete the clause | must-fix, resolved in `e2df5c6` |
| research/03-claude-code-capabilities.md:9 | local-env | owner home path (`which claude` output) | a generic tilde path for the launcher | should-fix, resolved in `e2df5c6` |
| research/03-claude-code-capabilities.md:66-76,91-92,120,192,194,198 | local-env | the operator's config and tool inventory | present as a hypothetical example | should-fix |
| research/04-cross-platform.md:57 | ticket/repo | `wt new-tab` example (format) | `lead-task-42` | should-fix, resolved in `e2df5c6` |
| research/04-cross-platform.md:3,158 | local-env | test environment fingerprint | keep | ok-to-keep |
| research/designs/design-a.md:62 | company | orchestrator.json example | a neutral placeholder path | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-a.md:127 | company | employer path plus an internal service repo | `~/src/my-repo` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-a.md:253 | ticket/repo | real keys plus the real project (and possibly a real sprint) | `PROJ-42`; `project=PROJ AND status='To Do'` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-a.md:5 | ticket/repo | Jira project key | "10 tickets" | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-a.md:115,127,132,136,143,148,150,157,158,160,162,173,230,248,249,263 | ticket/repo | format example throughout | `task-42` | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-a.md:115 | ticket/repo | possibly a real private PR number | `pull/123` | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-a.md:49,168 | local-env | operator config | generic wording | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:11 | company | employer path | "the repo checkout" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:197 | company | owner home plus employer path | `/abs/path/to/claude-soma-lite/…` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:142,146,147,150,160 | company | client repo plus employer path | `my-repo`, `~/src/my-repo` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:124,156,161,170,174,175,178,179,180,183,198,207,315,325 | ticket/repo | running example on the client repo | global replace with `task-42` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:136 | ticket/repo | names the real Jira project | "e.g. a Jira project" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:227 | ticket/repo | real ticket (work content) | "(reserve-before budget pattern)" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:199 | local-env | owner home path | a placeholder home path | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:318 | ticket/repo | Jira project key | "10 backlog items" | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:191,231 | local-env | operator config | generic wording | should-fix, resolved: file removed in `a6857b8` |
| research/designs/design-b.md:213 | local-env | probably the client repo's convention; not identifying | keep | ok-to-keep |
| research/designs/design-c.md:137 | company | employer path plus an internal service repo (names a product line) plus a real ticket | `~/src/my-repo`, `jira:PROJ-42` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-c.md:127,142,147,152,168,178,179,185,187,294 | ticket/repo | running example on the client repo | `task-42` | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-c.md:284 | ticket/repo | real Jira project | `project = PROJ`; drop the real-project clause | must-fix, resolved: file removed in `a6857b8` |
| research/designs/design-c.md:217-218 | local-env | operator config | generic wording | should-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:310-311 | company | where the employer's API keys live, plus vendor accounts | "a login shell that exports API keys" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:31-32 | local-env | credentials the operator holds (employer DB writes) | "e.g. MCP servers that can write a database" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:203-205 | ticket/repo | real ticket plus work content (a client product line) | "a backlog may hold tickets about HTTP 429s" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:271 | ticket/repo | real Jira project | "(the source project gets double-spammed)" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:138,151,361,427 | ticket/repo | format examples | `task-42` | should-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:141-142 | local-env | the employer's deploy topology (generic once unnamed) | "on repos where develop auto-deploys" | should-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:24,30-31,198,331-332 | local-env | the operator's MCPs and backlog | generic wording | should-fix, resolved: file removed in `a6857b8` |
| research/designs/gap-critique.md:413 | company | possibly client code (the directory name reads as a client feature) | `src/foo/status.ts` | should-fix, resolved: file removed in `a6857b8` |
| research/designs/judge-verdict.md:191-193 | company | states that the operator holds the employer's prod-adjacent DB credentials | "a DB MCP holding write credentials" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/judge-verdict.md:191-193,197,233-234 | local-env | the operator's MCP inventory | "write-capable, desktop-control and chat MCPs" | should-fix, resolved: file removed in `a6857b8` |
| research/designs/judge-verdict.md:123-124,256-257 | ticket/repo | real ticket (work content) | "a hard spend-cap, reserve-before pattern" | must-fix, resolved: file removed in `a6857b8` |
| research/designs/*.md (design-a:236-240, design-b:3,286,290, design-c:251,255,315, gap-critique:221, judge-verdict:11,30,136-137,240-248) | local-env | the operator's plan tier | keep (or "one subscription") | ok-to-keep |
| research/04-cross-platform.md:18,106,109,115 | local-env | a library version string, placeholder home paths and an example pull-request number, matched by pattern sweeps | keep | ok-to-keep |
| research/01-claude-soma-internals.md:697; research/designs/design-b.md:184; research/designs/judge-verdict.md:304; research/designs/design-c.md:170,190 | id/session/transcript | the general shape of a Claude Code session link, and a placeholder home path; no real id | keep (the design files are excluded anyway) | ok-to-keep |

#### 5.5.6 `test/fixtures/`

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| test/fixtures/limit-rows.json:2 | local-env | config dir, corpus size, internal report | "Derived from real transcripts; ids anonymised; text replaced by labels." | should-fix, resolved in `2063018` |
| test/fixtures/limit-rows.json:5-8,10-15,19-22,25-39,44-48,51-52,55,58,62 | id/session/transcript | real transcript file:line refs; test/limit-state.test.mjs:16,54 match two of them exactly | synthetic ids (`s01.jsonl:218` …), and update those two tests | should-fix, resolved in `2063018` |
| test/fixtures/limit-rows.json:9,16,17,18 | id/session/transcript | real subagent transcript ids | `agent-01.jsonl` … | should-fix, resolved in `2063018` |
| test/fixtures/limit-rows.json:6-11,19-22,25-39,58 | ops-data | dated record of the employer org hitting spend caps | keep the categories; cut the link to real dates and ids | should-fix, resolved in `2063018` |
| test/fixtures/limit-rows.json:5-62 | ops-data | the operator's real activity times (no prompt text, email, org id or account id) | shift to synthetic times (a real reset timestamp is hard-coded across tests and bin/lib/wd/limit-state.mjs) | should-fix, resolved in `2063018` |

#### 5.5.7 `test/*.mjs`

| file:line | category | finding | suggested fix | severity |
|---|---|---|---|---|
| test/pane-state.test.mjs:171-188 | id/session/transcript | client-work content (client product and project names) | neutral question and options; keep `❯ 1.`, RULE, `Type something.`, `Chat about this` and the footer | must-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:250 | company | real pane title from the client-work lead | `'✳ Claude Code'` | must-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:163,247 | ticket/repo | real lead and ticket | `lead-task-1`; drop the date and time | must-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:191,193,201,209,379,382,391 | ticket/repo | live lead name in the named rule and titles | `lead-task-2` (including the `.replace` at 391) | must-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:410,414 | ticket/repo | resurrected ghost session, "measured 2026-09-07" | `lead-task-3` | must-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:308 | ticket/repo | probably lifted from the live orchestrator pane | `soma peek task-1` | should-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:196,311,386,387,388 | local-env | the operator's orchestrator name (named after the employer) | `soma-orch` | should-fix, resolved in `82b090c`, `810887e` |
| test/pane-state.test.mjs:31 | local-env | origin of the STATUS_AUTO status line | "a second orchestrator socket" | should-fix |
| test/pane-state.test.mjs:125 | local-env | owner's machine name in the SHELL_BARE frame | `'host%'` | should-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:269 | local-env | owner's hostname as a trust-dialog pane title | a neutral hostname | should-fix, resolved in `82b090c` |
| test/pane-state.test.mjs:225 | id/session/transcript | measured real pane title (no client content) | `'✳ Claude Code'` | should-fix |
| test/pane-state.test.mjs:42,54 | local-env | probe banner shows a Team-plan seat | keep | ok-to-keep |
| test/watchdog.tick.test.mjs:114 | id/session/transcript | shortened copy of the client-work frame | synthetic text (only /Enter to select/ is asserted) | must-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:113 | ticket/repo | real lead and ticket | "an AskUserQuestion frame (2.1.263)" | must-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:97-98,101 | ticket/repo | real resurrected session | `◐ lead-task-1` | must-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:1181 | ops-data | real fleet rows with real ticket keys | "two rows a tmux-resurrect restore left as zsh" | must-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:1258 | ops-data | real fleet rows with real ticket keys | "prompt-blocked leads have been seen on re-briefed done rows" | must-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:1283 | company | real client-work pane title | synthetic title | must-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:118 | local-env | owner's machine name (×2) | `host%` | should-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:1218,1220,1232,1264 | id/session/transcript | real pane titles | synthetic titles (change 1220 and 1232 together) | should-fix, resolved in `7a551a2` |
| test/watchdog.tick.test.mjs:2346,2350,2352 | id/session/transcript | session-id prefixes; the employer org's monthly-cap event | keep only the labels Event A/C | should-fix, resolved in `2063018` |
| test/watchdog.tick.test.mjs:2161,2167,2303,2346,2348,2596,3291 | ops-data | a real reset time plus a local-time tell | drop "measured" and the local-time rendering | should-fix, resolved in `2063018` |
| test/watchdog.tick.test.mjs:455-456,790,1024-1027,3206-3207,3562-3564,3617-3618,4129 | ops-data | counts from the operator's transcripts | round values; drop the counts | should-fix, resolved in `2063018`, `bfb4fef` |
| test/watchdog.tick.test.mjs:1130-1135,1271,1830-1832,2011,3483 | ops-data | private tracker, incident, backlog, live config | generic wording | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:1131-1134 | company | client repo keys (abbreviations of the client repositories) mirroring the real soma.json | `app` / `api`, `main reachable` | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:138,1375,1488,1490,1532,1533,1555,1560,1568,1580,1583,1585 | company | client repo key in fixtures | same neutral key (change 138 with 1375 and 1488 with 1490) | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:50,1119-1121,2306,2349 | local-env | the operator's personal MCP | `extra_mcp` | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:625-632,2173,2175,2566 | local-env | the operator's personal servers | "two write-capable local-scope servers" | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:587,599,841,2310 | local-env | live fleet root name | `.claude-second` (repo-wide) | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:159,160,1413,1958,1963,1967,2041,2050,2071,2088,2100,2127-2135,2179,2181,2193,2226,2228,2312,2313,2370-2375 | local-env | real seat naming scheme | rename repo-wide or accept as a documented example | should-fix |
| test/doctor.test.mjs:171-172,507-508,1811-1813,1888,1914-1916,2207 | ops-data | operator fleet and account facts | generic wording | should-fix, resolved in `bfb4fef` |
| test/doctor.test.mjs:89-90,1808,2272,2356 | local-env | private tracker, untracked artifacts, real epoch | drop the references; use a round epoch | should-fix, resolved in `7a551a2`, `bfb4fef` |
| test/doctor.test.mjs:538-539 | secret | incident narrative, no value | keep; confirm rotation | ok-to-keep |
| test/hooks.test.mjs:2145 | company | a real command from a real stall: employer path, sprint, ticket, internal client document | `'cd ~/docs/proj-x && grep -n x notes.html',` (only asks[0] and asks[1] are asserted) | must-fix, resolved in `109c888` |
| test/hooks.test.mjs:313,2036 | local-env | the operator's personal MCP server | `mcp__extra__send` | should-fix |
| test/hooks.test.mjs:2099,2101-2108,2128-2129,2165,2278 | ops-data | fleet stats | proportions without counts | should-fix |
| test/bus-tools.orch.test.mjs:792,793,796 | company | client repo name | `'app-2.0'` / `'app-20'` | must-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:999 | company | client repo plus client-domain task title | `title: 'fix the widget', repo: 'r'` | must-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:1537 | ticket/repo | real lead and ticket | "LIVE frame (Claude Code 2.1.263)" | must-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:1542-1544 | id/session/transcript | copy of the client-work frame | neutral text (keep the footer exactly; 1611 `.replace`s it) | must-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:1595 | company | real client-work pane title | `'✳ Claude Code'` | must-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:1032 | ticket/repo | real ghost lead | `'◐ lead-task-7'` | must-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:509,519,535,547 | id/session/transcript | real session UUID (also in bin/lib/bus-tools.mjs:904) | a placeholder UUID (for example all zeros) | should-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:68-69,1120-1121 | ops-data | live fleet counts plus the work/personal split | drop the counts | should-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:1135-1137 | local-env | seat naming | neutral seat paths (keep the home prefix the assertion at line 1142 checks) | should-fix, resolved in `7a551a2`, `81a4daa` |
| test/bus-tools.orch.test.mjs:1524,1570 | id/session/transcript | private tracker; real pane title | drop; `'✳ Claude Code'` | should-fix, resolved in `7a551a2` |
| test/cli.test.mjs:144 | id/session/transcript | copy of the client-work frame | neutral text; keep the structure and footer | must-fix, resolved in `7a551a2` |
| test/cli.test.mjs:143,1726 | ticket/repo | real lead and ticket | "(measured live)" | must-fix, resolved in `7a551a2` |
| test/cli.test.mjs:223,233 | ticket/repo | real ghost lead | `task-7` / `'◐ lead-task-7'` | must-fix, resolved in `7a551a2` |
| test/cli.test.mjs:1179-1183,1282-1286 | local-env | the operator's two-fleet setup | "a second fleet on socket `soma_second`" | should-fix, resolved in `bfb4fef` |
| test/cli.test.mjs:1422,1424,1425,1437 | local-env | the real seat dir name | `'~/seat-b'` (or keep with RUNBOOK) | should-fix |
| test/cli.test.mjs:233 | id/session/transcript | real pane title | `'✳ Claude Code'` | should-fix, resolved in `7a551a2` |
| test/spawn.test.mjs:41,101,352,556,1358,1369,1471,1473,1493,1568 | local-env | the operator's config-dir name under a placeholder home | a neutral config-dir name under the placeholder home | should-fix |
| test/spawn.test.mjs:1331,1378,1416,1473,1586 | local-env | seat naming | a neutral seat-dir name under the placeholder home | should-fix |
| test/spawn.test.mjs:121,636,640,1212,1266-1267 | local-env | the operator's personal MCP servers | `'srv_a'`, `'srv_b'` | should-fix |
| test/spawn.test.mjs:28,30-31,322-326,334,353,365,392,406,1365-1366 | local-env | the operator's key inventory (names only) and machine layout | "typical hazards"; `SOME_VENDOR_API_KEY` | should-fix |
| test/spawn.test.mjs:498-500 | ops-data | fleet stats and private tracker | drop | should-fix, partly resolved in `48fbbfd`; the fleet stats remain |
| test/spawn.test.mjs:43-48 | secret | labelled dummies for the env-scrub test | none | ok-to-keep |
| test/spawn.test.mjs (139 lines), test/settings-gen.test.mjs (15 lines), many others | ticket/repo | single-digit placeholders that echo the internal project prefix | optional rename to `task-1` | ok-to-keep |
| test/tokens.test.mjs:1005 | company | the owner's username and the employer name in a slug example | a neutral example path and its slug | must-fix, resolved in `7a551a2` |
| test/tokens.test.mjs:1006 | company | the employer name, an internal repository, a real ticket key and the owner's initials in a slug example | a neutral example path and its slug | must-fix, resolved in `7a551a2` |
| test/tokens.test.mjs:1007 | company | the employer name, the client repository and the owner's initials in a slug example | a neutral example path and its slug | must-fix, resolved in `7a551a2` |
| test/tokens.test.mjs:1013 | person | the owner's initials | neutral initials (for example `OP`) | should-fix, resolved in `7a551a2` |
| test/tokens.test.mjs:15,79-80,96,102 | local-env | operator machine layout and config dir | `'.claude-live'` | should-fix, resolved in `bfb4fef` |
| test/tokens.test.mjs:1008,1021-1022 | local-env | real path fragments | `a_b` → `a-b`; a `mktemp -d` path | should-fix, resolved in `7a551a2` |
| test/tokens.test.mjs:312,316-318,337-338,367-368,550,670,902-903,908,915,943-944,971,978,980,999,1004,1012,1458 | ops-data | counts and values from the operator's transcripts | keep the reasoning, drop the figures | should-fix, resolved in `7a551a2`, `bfb4fef` |
| test/settings-gen.test.mjs:167,171,173,199,204,222,229,344,345,347,474,476,989,995,1017,1020,1054 | local-env | the operator's personal MCP | `'srv_a'` (re-sort the deepEquals at 173, 204, 229 and 347) | should-fix |
| test/settings-gen.test.mjs:211-216,220,222,229 | local-env | the operator's measured MCP inventory | `'design_srv'`, `'analytics_srv'`, `'db_srv'` | should-fix |
| test/settings-gen.test.mjs:293,299,308 | local-env | the operator's plugin and marketplace | `'term@m'`, `'plugin_term'` | should-fix |
| test/settings-gen.test.mjs:982-987 | local-env | the operator's account connectors | "claude.ai connectors never appear in ~/.claude.json" | should-fix |
| test/settings-gen.test.mjs:9-12,233-237,286,312,832,945-946,953 | local-env | the operator's config root | generic wording; `~/.claude-second` | should-fix |
| test/settings-gen.test.mjs:697-698,822 | local-env | operator token scope and `pass` layout | "a gh token with `repo` scope"; `pass show x/aws` | should-fix |
| test/settings-gen.test.mjs:802-805 | secret | incident narrative, no value | keep; confirm rotation | ok-to-keep |
| test/settings-gen.test.mjs:171-347,283-323,984 | local-env | generic public names (probably the real set) | optional rename | ok-to-keep |
| test/worktree.test.mjs:63,76,80 | company | client repo | `'acme-app'` | must-fix, resolved in `52f0e2c` |
| test/worktree.test.mjs:351 | company | client product name | `'Acme App 2.0/x'` → `'Acme-App-2.0-x'` | must-fix, resolved in `52f0e2c` |
| test/worktree.test.mjs:93-980 (88 lines, e.g. 93,100,105,107,113,118,123,333,344-346,390,486,506,521,855,951,967,980) | company | a client-repository abbreviation as the repo key | `'app'` (rename only the repository key, not unrelated identifiers that share its spelling) | should-fix, resolved in `0aa7aec` |
| test/fleet.test.mjs:52,170 | company | client repo in enqueue fixtures (no assertion reads it) | `'acme/app'` | must-fix, resolved in `7a551a2` |
| test/bus-tools.lead.test.mjs:578 | ticket/repo | real lead and ticket (the frame body itself is neutral) | drop the source note | must-fix, resolved in `f0cde29` |
| test/bus-tools.lead.test.mjs:572,635 | ticket/repo | private tracker | describe the incident | should-fix, resolved in `48fbbfd` |
| test/wd.test.mjs:377 | ticket/repo | format example | `task-1` | should-fix, resolved in `7a551a2` |
| test/wd.test.mjs:613 | local-env | timezone from a live pane | drop the clause | should-fix, resolved in `7a551a2` |
| test/wd.test.mjs:131-140,189-191 | ops-data | counts from the operator's transcripts | generic wording | should-fix, resolved in `bfb4fef` |
| test/seats.test.mjs:65-67 | local-env | real reset plus timezone | "an arbitrary 2026 epoch-ms value" | should-fix, resolved in `7a551a2` |
| test/seats.test.mjs:82,95-96,151-152 | local-env | seat naming | rename repo-wide or keep as the documented convention | should-fix |
| test/seats.test.mjs:36-38,888-889,913-914 | local-env | provenance note; no values read | optional | ok-to-keep |
| test/prompts.test.mjs:182-185,198,361,703-705 | ops-data | fleet stats | generalise, and change the pin in the same edit | should-fix |
| test/prompts.test.mjs:182,361,684 | ticket/repo | private tracker | describe the issue | should-fix, resolved in `48fbbfd` |
| test/pretrust.test.mjs:111,137,460 | local-env | the operator's personal MCP | `example` / `example-mcp` | should-fix |
| test/canary.test.mjs:62,64 | ops-data | private tracker and fleet stats | "leads sat on it for days" | should-fix, partly resolved in `48fbbfd`; the fleet stats on line 64 remain |
| test/soma-bus.smoke.test.mjs:1087-1088; test/fleet.test.mjs:736-738 | ops-data | the real reset epoch reused as a clock (harmless once the "measured" comments go) | change repo-wide or keep | should-fix, resolved in `7a551a2` |
| test/config.test.mjs:288,300,339,346,347 | company | client repo/product name in the merge and accumulate tests | `'app-a'` | must-fix, resolved in `b663b9a` |
| test/config.test.mjs:340,346 | company | a second client product name (its only occurrences in the repository) | `'app-b'` | must-fix, resolved in `b663b9a` |
| test/config.test.mjs:260,288,300,339,340 | company | client repo abbreviations | `/repos/app-a`, `/repos/app-b`, `cfg.repos.app` | should-fix, resolved in `b663b9a`, `0aa7aec` |
| test/config.test.mjs:523,525,540,546 | local-env | seat naming | `'/seats/seat-a'` | should-fix |
| test/harness.test.mjs:231,237 | company | client repo | `'app-a'` (change both lines together) | must-fix, resolved in `f0cde29` |
| test/harness.test.mjs:231,233,235,237,241,244 | ticket/repo | a real ticket key beside the client repository, its base branch and its test command | `task-11` / `TASK-11` | must-fix, resolved in `f0cde29` |
| test/paths.test.mjs:26,98 | company | client repo | `worktreeDir('app-a', 'task-1')` | must-fix, resolved in `52f0e2c` |
| test/paths.test.mjs:171-172 | local-env | the operator's config root | a neutral config-dir name; drop the clause | should-fix |
| test/standing.test.mjs:174 | company | the client repository plus the operator's state-root name | a neutral state-root and repository name | must-fix, resolved in `52f0e2c` |
| test/standing.test.mjs:161-168,187 | ops-data | private tracker plus fleet stats (also in README.md:254) | generalise together with README | should-fix, partly resolved in `48fbbfd`; the fleet stats remain |
| test/notify.test.mjs:83,86,97,100,110,118,247 | ticket/repo | format example in toast bodies | `task-1` (change each body and its expected string together) | should-fix, resolved in `f0cde29` |
| test/notify.test.mjs:379-386 | local-env | machine and local tree names in the flake rationale | optional "tree A / tree B" | ok-to-keep |
| test/rotation-events.test.mjs:68,71,72,80,81,88,89 | ticket/repo | real key used as a fixture id | `'task-1'` | should-fix, resolved in `7a551a2` |
| test/rotation-events.test.mjs:21,179,209,212 | ops-data | the real reset as the sample clock (the digits are inside regexes too) | `1_800_000_000_000` / `1_800_000_000` | should-fix, resolved in `7a551a2` |
| test/limit-state.test.mjs:16,54 | id/session/transcript | real session UUIDs with line numbers (match the fixture's `_source`) | synthetic ids, changed together with the fixture | should-fix, resolved in `2063018` |
| test/limit-state.test.mjs:15,17,52,139 | id/session/transcript | Event A / Event C provenance comments | the same synthetic ids | should-fix, resolved in `2063018` |
| test/limit-state.test.mjs:15,17,20,45,48,49,86,128,152,154,155,164,170,175,180,195,272,282,317,320,324 | ops-data | Event A's own clock, its resume and the real resets | shift with the fixture, or accept | should-fix, resolved in `2063018` |
| test/limit-state.test.mjs:115,117,118,152 | local-env | the operator's timezone plus the real pane text | `'Asia/Tokyo'` (comment-only changes); drop the local-time rendering | should-fix, resolved in `2063018` |
| test/seats-summary.test.mjs:17-18,40-42 | local-env | the operator's timezone plus the real pane text | `'Asia/Tokyo'` expecting `'1:30am'` | should-fix, resolved in `7a551a2` |
| test/seats-summary.test.mjs:17,21,23 | ops-data | the real reset as the anchor | any synthetic instant (recompute 47, 53, 59, 64 and 85) | should-fix, resolved in `7a551a2` |
| test/tmux.test.mjs:242-243 | ops-data | possibly a real capture (the date matches the spec's first day) | `'Thu Jan 1 00:00:00 2026'` | should-fix |
| test/lease.test.mjs:176-182; test/config.test.mjs:119-178 | ops-data | narrative and calibration stats, no identifiers (the same figures as bin/lib/config.mjs) | keep, or round together with config.mjs | ok-to-keep |
| test/notify.test.mjs:60,135 | person | stock kernel version banners whose build address matched the email sweep (public, not personal) | keep | ok-to-keep |
| test/wd.test.mjs:682; test/bus-tools.orch.test.mjs:1131,2499; test/cli.test.mjs:379,513,589 | ops-data | the real reset timestamp as a test clock or in comments | an invented epoch, changed together with the fixture | should-fix, resolved in `7a551a2` |
| test/bus-tools.orch.test.mjs:316,560,760,831,874,937,950,1172,1291,1293,1309,1367,1454,1477,1770,1817,1843,1863,1875,2034,2106,2273,2421,2653 | local-env | placeholder home paths and ids in error-message fixtures | keep | ok-to-keep |
| test/spawn.test.mjs:35,276,329,350,419,536,539,555,561,570,571,574,698,1138,1248,1258,1372,1440 | local-env | placeholder home paths, invalid-id fixtures and synthetic UUIDs | keep | ok-to-keep |
| test/hooks.test.mjs:149,202,265,328,363,1446,1495,1496,2214,2333 | local-env | placeholder ids, home paths and an example pull-request number | keep | ok-to-keep |
| test/bus-tools.lead.test.mjs:795,849,851; test/cli.test.mjs:884; test/settings-gen.test.mjs:396,826,827,838,1229 | local-env | placeholder ids and home paths | keep | ok-to-keep |
| test/fleet.test.mjs:137; test/standing.test.mjs:101; test/wd.test.mjs:382 | ticket/repo | invalid-id and placeholder fixtures that match the key pattern | keep | ok-to-keep |
| test/filelock.test.mjs:626; test/soma-bus.smoke.test.mjs:401,420 | ticket/repo | words that match the key pattern (false positives) | keep | ok-to-keep |
| test/doctor.test.mjs:36 | id/session/transcript | a synthetic UUID | keep | ok-to-keep |
| test/notify.test.mjs:106,133,134 | local-env | stock WSL kernel version banners | keep | ok-to-keep |

## Appendix A. Documentation drift to fix before launch (outside this branch)

Places where an existing document or code comment says something the code at `9ca4293` does not
do. The launch branch edits several of these files, but only to remove private data: the drift
below is still there, except the two `RUNBOOK.md` rows marked resolved. `README.md` and the new
documents state the code's behaviour instead. Line numbers are at `9ca4293`. Edit `RUNBOOK.md`
together with the tests that read it (§5.3).

### `RUNBOOK.md`

| where | what it says | what the code does |
|---|---|---|
| line 21 (§0) | the safety model is "58 rules" | 95 machine-independent deny rules, the figure the RUNBOOK's own §11.3 gives (`bin/lib/settings-gen.mjs:740-790`, `962-1010`) |
| lines 68, 71 and 80 (§1, §2) | `npm test` passes 902 tests | the suite now has 1,300+ tests, and one of them depends on the machine (Appendix B) |
| line 56 (§1) | `npm test` is `node --test "test/**/*.test.mjs"` | the script also sets a throwaway `SOMA_HOME` (`package.json`) |
| line 120 (§3) | `leads/<id>/` holds `brief.md` | nothing writes `brief.md` (or `meta.json`); the brief travels on the lead's argv. The tree also omits `standing.md`, `CD_COMPOUND_ASKS`, `state/last-wake`, `state/repo-<slug>.lock` and `events/.cursors.json` |
| line 158 (§4) | `tick_ms` is "Floored at 1000" | a value below 1000 falls back to 30000 (`bin/soma-watchdog.mjs:2076-2083`) |
| line 217 (§5.1) | `init` runs `claude mcp add soma -s user -- <node> <bus>` | it also pins `-e SOMA_HOME=…` and `-e SOMA_TMUX_SOCKET=…` (`bin/soma.mjs:1330-1333`) |
| lines 241-264 (§5.1) | `init` always prints `inject hook: NOT installed …` | `init` reads `settings.json` and prints one of three states: registered, NOT installed or NOT OBSERVED (`bin/soma.mjs:1412-1441`) |
| lines 298-305 (§5.2) | `lead edit ban on argv` asserts the ban is present | the row asserts the ban is **absent**: leads carry no `--disallowedTools` (`bin/lib/doctor.mjs:1047-1058`, `bin/lib/spawn.mjs:653-677`) |
| line 373 (§5.2) | a `doctor: PASS — all 48 checks hold` summary | PASS is unreachable: `workflows enabled` is hard-wired to unobserved and nothing writes the file `session id matches hook payload` compares against (`bin/lib/doctor.mjs:2016`, `2314-2317`) |
| line 277 (§5.2) | the cd-compound probe takes "~8 s" | the code comment says about 15 s (`bin/lib/doctor.mjs:1963`) |
| line 396 (§5.3) and lines 447-461 (§5.4) | `--canary` refuses with exit 3 and the quoted message | with the real wiring the canary throws *the canary needs a live driver*, and `soma up` exits 2 (`bin/lib/canary.mjs:618-627`, `bin/soma.mjs:1990-1993`) |
| line 436 (§5.3) | EOF at the confirmation prompt returns `null`, exit 3 | EOF is a decline, exit 1 (`bin/soma.mjs:513-518`) |
| lines 216 and 481 (§5.1, §6.1) | the skill is `/soma:promote` | the installed skill is named `soma-promote`, so the command is `/soma-promote` (`skills/soma-promote/SKILL.md:2`, `bin/soma.mjs:439-453`) |
| lines 493-495 (§6.1) | `degraded_wake: true` means the session is "not in a tmux pane", which implies that any tmux pane gets keystroke wake-ups | only a pane on soma's own tmux server does; in any other tmux the wake-up can be typed into the pane with the same id on soma's server (Appendix B) |
| line 545 (§6.3) | the tick "does seven things" (0 to 6) | it has eight phases: the limits phase for account rotation runs second (`bin/soma-watchdog.mjs:501-730`) |
| line 894 (§10) | `leadCannotWrite`: the lead is denied Edit, Write and NotebookEdit | the lead's write ban was lifted; a lead may edit and commit in its own worktree, and only `git push` and `git merge` are denied to it (`bin/lib/spawn.mjs:114-127`, `bin/hooks/lead-gate.mjs:18-26`, `prompts/lead.md`) |
| lines 1084-1093 (§11.0) | doctor certifies the gate "from its matcher alone", and a doctor check that reads a hook's command is "not done" | two doctor rows read each hook's command and require an on-disk `lead-gate.mjs` (`bin/lib/doctor.mjs:947-993`). The inject-hook installer it also names is still missing |
| lines 1286-1303 (§11.9) | `buildLeadArgv()` "still emits `--disallowedTools`"; do not remove it | it emits none (`bin/lib/spawn.mjs:653-677`) |
| lines 659-662 and 994-1010 (§7, §10) | quote identifiers and code from the Claude Code bundle | resolved in `d744f47`: the passages describe the observed behaviour in prose (§4) |
| lines 948-954 (§10) | cite a gitignored internal report by line number | resolved in `fd72a5a`: the citations are gone (§5.2, item 10) |

### `docs/ROADMAP.md`

| where | what it says | what the code does |
|---|---|---|
| line 3 | leads are "planning-only" | leads may edit and commit in their worktree (`prompts/lead.md`) |
| line 12 | `soma_digest` "returns per-task rows" | it always refuses: the digest composer is not built (`bin/lib/bus-tools.mjs:2365-2372`) |
| line 16 | `soma retry` is a v1.x item | it is implemented for `failed` and `skipped` rows (`bin/soma.mjs:1767-1811`) |
| line 61 | "v1 emits raw `STALLED` … events" | nothing produces `STALLED` |
| lines 114-116 | `soma doctor` reports a declared-but-unimplemented config key such as `env_allow` | no doctor check does, and nothing in `bin/` reads `env_allow` |
| line 158 | recovery runs `/soma:promote` | the command is `/soma-promote` |

### `skills/soma-promote/SKILL.md`

| where | what it says | what the code does |
|---|---|---|
| line 3 | the operator types `/soma:promote` | the installed skill is named `soma-promote`, so the command is `/soma-promote` |
| line 31 | a refused adopt returns the holder's `heartbeat_at` | it returns `heartbeat_age_ms` (`bin/lib/bus-tools.mjs:1194-1203`) |
| line 34 | a forced steal "appends a `DEMOTED` event" | it types a notice into the old holder's pane; no event is appended (`bin/lib/bus-tools.mjs:1285-1304`) |
| lines 37-39 | `degraded_wake: true` means the session is "not in a tmux pane" | as for RUNBOOK §6.1 above: only a pane on soma's own tmux server gets keystroke wake-ups (Appendix B) |
| line 119 | the inject hook "advances the `orch` cursor itself" | it advances its own `orch-inject` cursor (`bin/hooks/orch-inject.mjs:33-45`) |

### `prompts/` (the orchestrator contract and the lead playbook)

| where | what it says | what the code does |
|---|---|---|
| `prompts/orchestrator.md:5` | stall episodes and "the digest" are the watchdog's | the watchdog has neither (`bin/soma-watchdog.mjs:70-74`) |
| `prompts/orchestrator.md:29,35` | send `verify_hint` in `soma_enqueue` | the schema does not accept it and `fleet.enqueue` drops it (Appendix B) |
| `prompts/orchestrator.md:60` and `prompts/lead.md:165` | at 80% of its budget the lead is told, or warned | the 80% `BUDGET` event goes only to the orchestrator's stream (`bin/soma-watchdog.mjs:1099-1103`) |
| `prompts/orchestrator.md:61` | a `storm` freeze lifts itself | storm detection is a stub, so a storm freeze never happens (`bin/soma-watchdog.mjs:1957`) |
| `prompts/orchestrator.md:64` | after a `BLOCKED`, "`soma_spawn` it back in" | `soma_spawn` refuses any row that is not `queued` (`bin/lib/bus-tools.mjs:1572-1573`) |
| `prompts/orchestrator.md:65` | `HARNESS_DEFAULTED` means the lead named a harness the registry lacks | it fires whenever the budget-class lookup returns nothing, and never for a lead that has not declared a harness yet: that lead is priced as H1 without an event (`bin/soma-watchdog.mjs:1046-1056`) |
| `prompts/orchestrator.md:99-100` | append `WRITEBACK_OK` or `WRITEBACK_FAILED` yourself | no orchestrator tool can append an arbitrary event |
| `prompts/orchestrator.md:109` | `soma_digest()` on demand | it always refuses |

### Code comments and help text

| where | what it says | what the code does |
|---|---|---|
| `bin/hooks/orch-inject.mjs:13` | "Registered at user scope by `soma init`" | nothing registers it (`bin/soma.mjs:1395-1441`) |
| `bin/hooks/orch-inject.mjs:6-8`, `bin/lib/bus-tools.mjs:39-42`, `bin/soma-bus.mjs:530` | the watchdog batches what the orchestrator missed; "the rest batch" | nothing batches lead events |
| `bin/soma-bus.mjs:544`, `bin/lib/settings-gen.mjs:512-516` | checkpoints and heartbeats feed the watchdog's stall detector | there is no stall detector, and the watchdog never reads `heartbeats/` |
| `bin/lib/standing.mjs:155-159`, `bin/hooks/lead-postcompact.mjs:40-41` | the lead is "planning-only", and teammates do every edit | the same standing brief also carries `prompts/lead.md`, which says the lead may edit and commit |
| `bin/lib/harness.mjs:7-11` | the registry schema is "attributed" and "field-compatible" with loop-engineering | see §3 |
| `bin/lib/wd/budget.mjs:56-57`, `prompts/harnesses.json:82` | the babysit class is 500k tokens, or 500k a day | it is 8,000,000 tokens, with no daily accounting (`bin/lib/config.mjs`) |
| `bin/lib/canary.mjs:98` | `leadCannotWrite` is an invariant | the ban it checks was lifted |
| `bin/soma-watchdog.mjs:1200-1201` | a `VERSION_GATE` stays closed until `soma up --canary` re-proves the invariants | `--canary` cannot pass on this build |
| `bin/soma.mjs:269` (`soma help`) | `retry` puts "a finished row" back on the queue | it refuses `done` rows and re-queues only `failed` and `skipped` (`bin/soma.mjs:117`, `1785-1792`) |
| `bin/soma.mjs:274-275` (`soma help`) | "Mutating commands take --as" | only `send`, `kill`, `resume`, `retry` and `thaw` read it; `enqueue`, `up` and `down` ignore it (`bin/soma.mjs:695-696` and its five callers) |

### The design spec and the plans

The 2026-07-29 design spec and both plans predate the build's corrections: for example `soma orch`,
an MCP prompt, an inject hook installed by `init`, a `fable` model pin with `--disallowedTools`, and
budget caps of 300k to 3M tokens. The rotation plan's header described the seat order as
"least-recently-closed"; `pick()` now takes the first open seat in `soma.json` order
(`bin/lib/seats.mjs:275-289`). Both plans are removed on the launch branch (`a6857b8`), and
`README.md` now warns that the design spec predates the corrections (`ec253d5`).

## Appendix B. Code follow-ups

Code changes that this audit recommends and no branch has made yet. The launch branch edits code
only to remove private data, so every item below is still open except the licence row.

| item | where | what to do |
|---|---|---|
| doctor's `lead mcp single-server` fails once any lead exists | `bin/lib/doctor.mjs:801-806` against `bin/lib/settings-gen.mjs:470-484` | every lead's MCP config names `soma` and the stateless sequential-thinking server, but the check requires exactly `["soma"]`; accept that pair |
| a stale "one-server" comment | `bin/lib/spawn.mjs:27` | the lead's `--mcp-config` names two servers, `soma` and sequential-thinking; fix the comment together with the doctor check |
| `verify_hint` is accepted in a task file but never reaches the lead | `bin/lib/fleet.mjs:281-301` (the row is built from an explicit field list), read by `bin/lib/standing.mjs:140` and returned by `soma_task` (`bin/lib/bus-tools.mjs:784`) | carry it onto the row, and add it to the `soma_enqueue` schema (`bin/soma-bus.mjs:577-592`); until then every standing brief says `verify: (none configured)` |
| the one failing test | `test/tokens.test.mjs`, *the operator's live transcripts carry no usage field this module does not know* | `bin/lib/tokens.mjs` does not classify the `fallback_credit` usage field that current Claude Code writes; classify it as counted or ignored, with a reason |
| harness attribution | `prompts/harnesses.json`, `bin/lib/harness.mjs:7-11` | add the loop-engineering attribution where the registry is defined, and correct the "attributed" and "field-compatible" claims (§3) |
| licence metadata | `package.json` | done in `c811627`: `"license": "MIT"` added, `"private": true` kept (§2) |
| `soma up --canary` | `bin/lib/canary.mjs:618-627`, `bin/soma.mjs:1990-1993` | catch the missing-driver error and refuse with exit 3 and the documented message, rather than exiting 2 |
| `soma help` text | `bin/soma.mjs:269`, `274-275` | say that `retry` re-queues `failed` and `skipped` rows, and either honour `--as` in `enqueue`, `up` and `down` or stop claiming it for them |
| the budget class | `bin/soma-watchdog.mjs:1046-1056`, `bin/soma-bus.mjs:588` | the breaker prices a lead by its declared harness only (H1 until the orchestrator drains the `HARNESS` report), while the `soma_enqueue` schema says `budget_class` overrides it; make them agree |
| the 80% budget warning | `bin/soma-watchdog.mjs:1099-1103` | deliver it to the lead, or change the prompts that promise it |
| hooks nothing registers | `bin/hooks/lead-postcompact.mjs`, `bin/hooks/orch-inject.mjs` | add installers, or keep documenting the manual setup |
| events with no producer | `STALLED`, `TEAMMATE_DOWN`, `DEMOTED`, `WRITEBACK_OK`, `WRITEBACK_FAILED` | implement them, or remove them from the prompts and the skill (`DEMOTED` exists only as a notice typed into the displaced holder's pane) |
| storm detection | `bin/soma-watchdog.mjs:1957` | the evidence source is a stub that returns nothing, so storm freezes never happen |
| per-lead record | `bin/lib/fleet.mjs:293`, `bin/lib/paths.mjs:159` | nothing writes `leads/<id>/meta.json`, and every task row stores `base_sha: null` |
| a heap assertion that depends on garbage collection | `test/tokens.test.mjs:856-877`, *readUsage does not hold the whole transcript in memory* (the assertion is at line 876) | the test measures how far `heapUsed` grows across one `readUsage` call and requires less than 6 MB, but `global.gc?.()` does nothing because `npm test` does not pass `--expose-gc`, so the reading depends on when V8 collects. It failed once in the verifier's gate on the base commit ("heap grew 18.5 MB reading an 8 MB transcript"), and not in six reruns at the base and the head. Use a bound that does not depend on garbage collection, or run the test with `--expose-gc` and force a collection before measuring |
| doctor rows that can never be observed | `bin/lib/doctor.mjs:2016`, `2314-2317` | `workflows enabled` is hard-wired to unobserved, and nothing writes `state/last-hook-payload.json`, so doctor can never print PASS |
| the orchestrator's pane is never checked against soma's tmux server | `bin/lib/bus-tools.mjs:1270-1274`, `942`; `bin/lib/tmux.mjs:294-302` | `soma_adopt` records the session's `TMUX_PANE` next to soma's socket without checking that the pane lives on that server, so an orchestrator promoted inside the operator's own tmux can have lead wake-ups typed into whichever pane holds the same id on soma's server, which can be a lead's or a teammate's. `wake()` first reads that pane and holds the send if it shows a dialog, a shell or nothing readable (`bus-tools.mjs:654-656`), so not every wake-up lands. RUNBOOK §6.1 and `skills/soma-promote/SKILL.md:37-39` describe only "not in a tmux pane" as degraded, which implies any tmux works (Appendix A). Check the pane against the socket at adopt time, or fall back to notify mode. The README and the install guides now warn against it (read from the code, not tested) |
| leads always wake on the default socket | `bin/lib/spawn.mjs:98`, `715-745`; `bin/lib/settings-gen.mjs:476`; `bin/lib/bus-tools.mjs:625-676`, `756`; `bin/lib/tmux.mjs:28`, `43` | a lead runs under `env -i` with `ENV_ALLOW` and soma's own names, none of them `SOMA_TMUX_SOCKET`, and its MCP config adds none. `soma_report` runs `wake()` in the lead's own bus, which reads and types into the lease's pane on the default `soma` server with no socket check (`demote()` has one, at `bus-tools.mjs:1292`). A fleet on another socket therefore gets no keystroke wake-ups, and while a fleet on the default socket is running, they can land in that fleet's panes. The README and the guides tell such a fleet's orchestrator to run outside tmux. Forward `SOMA_TMUX_SOCKET` to leads through `ENV_ALLOW` and the lead's `mcp.json` env, and have `wake()` check the socket the lease records before it types (read from the code, not tested) |
| `max_leads` written as a string | `bin/lib/tokens.mjs:798-821`, `bin/lib/fleet.mjs:357-365` | the spend projection reads it as 0 leads while admission accepts the numeric string; validate it once |
