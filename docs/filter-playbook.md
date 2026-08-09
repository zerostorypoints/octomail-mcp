# A Gmail filter playbook

Lessons from cleaning up three real, years-old mailboxes with Octomail. The
first: ~1000 messages, a dozen machine senders, one filter to start with.
The second: 48,000 messages, ~70 filters, and seven independent review
rounds before the filters were provably safe. The third: a shared company
mailbox — five aliases, one inbox, a Polish-only taxonomy, and again seven
review rounds converging 4→5→3→1→1→1→0 findings. The fourth: a tune-up of a
mailbox whose owner had already built a working scheme by hand — where every
defect turned out to live in the incumbent filters (lesson 18). In all four,
an agent did the work with a human approving each step. Everything below was
learned by getting it wrong first, so you don't have to.

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
6. **Run creation and verification as a loop, not a sequence.** Don't verify
   once at the end — alternate rounds of filter work with a *fresh*
   independent reviewer each time, and only stop on an ACCEPT with zero
   findings. A second mailbox cleanup run this way took seven rounds: two
   early accepts, then four consecutive rejections that each exposed a
   different defect class (subject-stemming gaps, a transactional subdomain,
   stale labels, a missing language), then a clean accept. No single pass —
   however careful — found more than one of those classes; the loop found
   them all. Give each reviewer the journal of what was done, the invariant
   list, and explicit license to probe creatively (multilingual subjects,
   receipt vocabulary, auth vocabulary) rather than just re-running the
   author's own checks.
7. **Iterate.** Clearing the loud noise reveals the quiet noise underneath.
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

### 10. Gmail subject matching does not stem

`subject:confirm` does not match "Confirmation". `subject:login` does not
match "log in". A carve-out that names "code" still archives a message whose
subject says "PIN". Every auth carve-out we wrote with a three-word
vocabulary leaked, and each leak was a different spelling of the same
intent. Write carve-outs with the full family — verify, verified,
verification, code, PIN, confirm, confirmation, password, login, "log in",
"magic link", "sign in", "one-time", OTP, "action required", activate — and
in **every language the sender writes** (a Polish shop's account mail says
"Potwierdź" and "hasło", and no English list will ever catch it). Then
accept that the list is still incomplete, which is what the verification
loop (workflow step 6) is for.

### 11. Editing a filter does not re-sort old mail

Backfill happens under the filter that existed at the time. When you later
widen a carve-out, everything labeled under the old, narrower rule keeps its
label — the mail your new negation would now protect is still sitting in
the bulk pile. After every carve-out edit, run the negation's terms as a
*positive* query against that sender's bulk label and repair the hits.

### 12. A growing blocklist means stop filtering that sender

This is lesson 2 biting harder. Our exchange filter's carve-out grew from
three terms to twenty-three across four review rounds — codes, delistings,
KYC demands, funding changes, distribution records — and a fresh reviewer
still found account-critical mail under the bulk label. The fix was not a
twenty-fourth term: it was deleting the skip-inbox filter entirely and
giving the sender a label-only Ops treatment. For any sender that holds
your money or your identity (exchanges, banks, brokers), weekly marketing
in the inbox is cheaper than one archived KYC deadline.

### 13. The marketing subdomain carries transactional mail too

Lesson 3's nastiest variant: the *same subdomain* you verified as
"marketing only" can host a transactional sender you never sampled.
`deals.banggood.com` sends newsletters from `newsletter@` — and order
receipts from `trigger@`. And Gmail's `from:` is a suffix match, so a
filter on `email.playstation.com` also catches `txn-email.playstation.com`.
Scope filters to the full address (`newsletter@deals.example.com`), not the
subdomain, unless you have positively enumerated every local-part on it —
and when auditing, search the domain under its bulk label and read the
distinct senders that actually got caught.

### 14. Every archiving sender is an auth sender until proven otherwise

The dominant defect class of our third cleanup — seven of fifteen findings
across seven review rounds — was one pattern: a sender filtered as "cost
receipts" or "social noise" that *also* sends authentication or
account-critical mail. Adobe's receipt address also sends verification
codes. A job board's notification address also sends account activations.
An invoicing platform sends password resets and refund notices between the
proformas. One vendor's *entire* corpus turned out to be sign-in codes —
filtered straight to the archive with a forward attached. LinkedIn,
Instagram and TikTok each hide a security sender inside their notification
domains. Lesson 4 said carve out auth mail where you *know* it mixes; the
stronger rule is: before any filter removes INBOX, positively probe that
sender's history for auth and account-critical templates (codes, resets,
"action required", past-due, suspensions) and write the carve-out first.
Assume the mix; make the sender prove it's pure.

### 15. Backfill labels your sent mail too

Live filters only see incoming mail; a backfill that replays criteria as a
search query sees *everything* — including SENT. Gmail's `to:` operator
also matches Cc, so a recipient-based rule sweeps up your own replies
whenever someone self-CCs. Two of our "invoice" labels quietly acquired
sent test messages and self-copies this way. After every alias- or
recipient-based backfill, run `in:sent label:<target>` and adjudicate the
hits — and remember the check detects only over-labeling; run the negation
(`<query> -label:<target>`) for the misses.

### 16. One relay address, many issuers

Invoicing platforms send many customers' documents from a single relay
address. Ours (`no-reply@poczta.wfirma.pl`) carried a hosting vendor's cost
invoices *and* a former contractor's — same `from:`, opposite categories.
The From display name and body, not the address, identify the real issuer.
Before filtering any e-invoicing relay, enumerate the issuers behind it and
accept that the filter's category is only as pure as that list; record the
impure case as a watch item.

### 17. Clean both sides of every partition

Every sweep in this work splits the mailbox in two — in inbox or archived,
before a date or after, labeled or not — and a cleanup scoped to one side
silently claims completeness for both. Our star cleanup ran `is:starred
-in:inbox`, declared victory, and left 266 machine stars sitting *in* the
inbox; a "full history" backfill dropped a contiguous four-month window
mid-range and no boundary check could see it. After any bulk operation,
verify with a query that covers the *complement* of what you touched:
re-run the source query with the target negated, on both sides of every
boundary you used, and count returned messages — never the estimate field
(ours was stuck at 201 for result sets of 11, 13 and 25).

### 18. The incumbent filters are where the bodies are buried

The fourth mailbox was a tune-up: the owner's own hand-built scheme, years
old, visibly working. Every single defect the review loop found — thirteen,
across four rounds — was in the *incumbent* mute filter, not in the new
work. It archived the e-signature service (twelve of twelve messages were
contracts awaiting signature), the workspace admin's security alerts, bounce
notices, a compliance deadline ten days out, and the password resets of the
platform the owner administers. "It's been working for years" is not
evidence of safety; it means the failures are already in the archive where
nobody looks. A tune-up scope ("don't rebuild, just extend") does not exempt
the existing rules from the lesson-14 audit — it makes that audit the most
valuable part of the job.

### 19. Hand-moving a message is not a fix

When a review finds a wrongly archived message, restoring it to the inbox
repairs the *symptom*. If the live filter still matches that message's
template, the vendor's next re-send is archived again — which is exactly
what happened to a compliance reminder we had restored by hand one round
earlier. The fix is done only when the filter's criteria stop matching the
template, and there is a decisive check for that: take the new filter's
rendered query, AND it with the protected message's subject terms, and run
it as a search — the protected id must be absent from the results. Expect
the carve-out vocabulary to need several iterations against real templates
(ours shipped at v4); each iteration gets the same decisive check, not a
fresh promise.

### 20. The payoff is what the noise was hiding

The point of all this was never tidiness. Clearing ~40 machine messages a
month exposed, in one mailbox: a hosting plan at 300% of quota, a mandatory
security deadline two months out, a lapsed developer-program enrollment, and
two cloud projects that had been silently paused for weeks — every one of
them previously buried between a deploy comment and a DMARC report. If your
cleanup doesn't end with a short list of things to actually *do*, look again.
