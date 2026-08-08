# A Gmail filter playbook

Lessons from cleaning up a real, years-old mailbox with Octomail: ~1000
messages, a dozen machine senders, one filter to start with, and an agent doing
the work with a human approving each step. Everything below was learned by
getting it wrong first, so you don't have to.

## The goal, stated correctly

The goal is not "label everything". The goal is: **after the filters run,
whatever remains in the inbox is mail a human needs to see.** That inversion
matters, because the last category — real correspondence — is the one you
cannot write a filter for.

## The workflow

1. **Survey before you sort.** Profile, labels, existing filters, and a sample
   of recent mail. Don't trust `resultSizeEstimate` for anything over ~200 —
   Gmail caps it. Get real counts from narrow, dated queries or from backfill
   dry runs.
2. **Design the taxonomy by function, not by sender.** `Ops/DMARC`,
   `Ops/Errors`, `Billing`, `Social` — a new sender slots into an existing
   label instead of demanding a new one.
3. **Map each vendor's sender space before writing its rule.** One company is
   several senders with different intent (see lesson 3).
4. **Create the filter, then dry-run its backfill and read the sample.** Every
   filter, no exceptions. The dry run is where design errors surface as
   concrete wrong messages instead of abstractions.
5. **Apply, then verify with fresh eyes.** State invariants ("no DMARC in the
   inbox", "login codes still in the inbox") and check them with searches. If
   an agent did the sorting, have a *different* agent try to falsify the
   result — every independent verification pass in our run found something the
   author had missed.
6. **Iterate.** Clearing the loud noise reveals the quiet noise underneath.
   Expect two or three rounds before the inbox is honest.

## The lessons

### 1. Subtraction does not work

The tempting catch-all — "everything sent to me that is *not* from a known
machine sender is correspondence" — failed immediately: a third of the mailbox
matched, most of it newsletters and product announcements the exclusion list
didn't know about. The machine-sender tail is unenumerable; every week invents
a new `noreply@`. Gmail's own categories don't save you either:
`category:promotions` misses marketing that lands in Updates, and
`CATEGORY_PERSONAL` is fooled by cold outreach that is *written* to look
personal — which is exactly what makes real first-contact mail and spam
structurally identical.

Define noise positively, sender by sender, and let the inbox remainder *be*
the correspondence. Label real relationships by hand, or by a narrow
allow-list of partner domains you extend as relationships start.

### 2. Positive signals beat blocklists

A rule for CI notifications built as "GitHub minus deploy-bot minus 'left a
comment' minus 'requested your review' minus …" leaked a human reply on the
first verification pass, and the second pass found the phrase list would leak
forever ("closed #N", "reopened #N", …). The fix was one positive signal:
machine notifications had `"Run failed:"` in the subject; human mail never
did, and human replies start with `Re:`. When a blocklist keeps growing,
you're filtering from the wrong side.

### 3. One vendor is several senders

Map the whole sender space before writing a rule. Real examples:

- Supabase: `ant.wilson@` sends operational pause notices (keep in inbox),
  `welcome@`/`noreply@` send marketing drip and newsletters (archive) — but
  the same addresses also send email confirmations and deadline reminders
  (keep!).
- TikTok: notifications from `service.tiktok.com`, but login codes from
  `account.tiktok.com`. A carve-out on the first domain does nothing for the
  second.
- Sentry: alerts from `md.getsentry.com`, account mail from `sentry.io`.

A filter for the address you happened to see catches half the vendor.

### 4. Never archive authentication codes

Any sender that mixes notifications with login/verification codes needs a
carve-out before you archive it: exclude
`subject:(verification OR code OR confirm)` (add `reminder` for deadline
notices). Then verify the codes actually remain in the inbox — a code you're
waiting for that silently lands in an archived label is a lockout with extra
steps.

### 5. Forwarding filters deserve the most paranoia

A filter that forwards matches mail *off your account*. Ours, first drafted as
sender-only matching, would have forwarded domain-registration confirmations,
email-verification links, and account-suspension notices to a third party —
including material that maps out your infrastructure. Rules for the rule:

- Constrain by **sender AND subject** (`invoice OR receipt OR refund` …), plus
  a negated list for the sender's non-billing mail (`verify`, `action
  required`, `domain registered` …).
- Include **every language your vendors bill in**. Ours needed English,
  Polish (`faktura`), and German (`Rechnung`) — the German invoice matched
  nothing until we looked at it.
- Audit **every single historical match** before trusting it. Billing volumes
  are small enough to read the full list; do.
- Gmail only accepts an already-verified forwarding address, verified by a
  human in Settings. Treat that friction as a feature.

### 6. Scope free-text matches to a sender

A filter whose only criterion is a bare string (`vercel[bot]`) archives any
mail that merely *mentions* the string — one quoted phrase in a human reply
away from a lost message. Pair every content match with a `from:`.

### 7. Filters are append-only in practice

The Gmail API has no filter update; editing means delete + recreate. When you
can't delete (permissions, caution), a **supplementary filter is equivalent**:
Gmail applies every matching filter, so two rules adding the same label behave
as one broader rule. Overlap is harmless when the actions agree.

### 8. Know what filters cannot do

- **No retroactive application.** The UI's "apply to matching conversations"
  has no API equivalent — hence Octomail's `gmail_backfill_filter`, which
  translates criteria to a search query. The translation is an approximation
  (that's why it's dry-run by default), and it deliberately ignores a
  filter's `forward` action: replaying a rule must never blast old mail at
  someone.
- **Sent mail is untouched.** Filters run on incoming mail only; your half of
  a thread stays unlabelled.
- **One user-defined label per filter** (system labels unrestricted), and
  label "hierarchy" is just a name path — `Clients2` is not a child of
  `Clients`.
- The Gmail UI doesn't live-refresh API changes. Refresh before concluding
  something didn't work.

### 9. Delete in classes, and keep the audit trail

Deleting means adding `TRASH` — a 30-day undo window, with the irreversible
"empty trash" left as a deliberate human click. Delete by reviewed class
(deploy comments, expired codes, superseded reports, unsubscribed
newsletters), never by ad-hoc sweep, and exclude anything that documents
account history: security alerts, OAuth authorization notices, registration
confirmations, invoices. For classes over a few hundred messages, the web
UI's select-all-matching is one deterministic action and beats looping an
API that throttles bulk modifies.

### 10. The payoff is what the noise was hiding

The point of all this was never tidiness. Clearing ~40 machine messages a
month exposed, in one mailbox: a hosting plan at 300% of quota, a mandatory
security deadline two months out, a lapsed developer-program enrollment, and
two cloud projects that had been silently paused for weeks — every one of
them previously buried between a deploy comment and a DMARC report. If your
cleanup doesn't end with a short list of things to actually *do*, look again.
